import { chromium, type Locator } from 'playwright';
import postgres from 'postgres';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { travelingPplDraft } from '../src/lib/traveling-ppl';
import type { ProgramDraft } from '../src/lib/program-draft';

// No fallback, no .env loading, no production fixtures, no truncation.
const allowedDatabase = 'postgresql://builder@127.0.0.1:55441/builder_browser';
if (process.env.DATABASE_URL !== allowedDatabase) {
	throw new Error('REFUSED: DATABASE_URL must exactly match the isolated builder_browser URL');
}
const origin = 'http://127.0.0.1:5179';
const output = fileURLToPath(new URL('../../evidence', import.meta.url));
await mkdir(output, { recursive: true });
const db = postgres(allowedDatabase, { max: 1 });
const suffix = randomUUID();
const prefix = 'Synthetic builder acceptance ';
const name = `${prefix}${suffix}`;
const errors: string[] = [];
const checks: string[] = [];
const screenshots: string[] = [];
const layouts: object[] = [];
const ids: Record<string, unknown> = {};
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
	viewport: { width: 390, height: 844 },
	isMobile: true,
	hasTouch: true,
	deviceScaleFactor: 1
});
page.setDefaultTimeout(15000);
page.on('pageerror', (error) => {
	errors.push(`pageerror: ${error.message}`);
	console.error(error.stack);
});
page.on('console', (message) => {
	if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});
page.on('dialog', (dialog) => dialog.accept());
const field = (label: string) => page.getByLabel(new RegExp(`^${label.split(' ').join('\\s+')}`));
const button = (label: string) => page.getByRole('button', { name: label, exact: true });
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function settled() {
	await page.waitForLoadState('networkidle');
}
async function checkpoint(label: string) {
	await settled();
	const size = await page.evaluate(() => ({
		viewport: window.innerWidth,
		document: document.documentElement.scrollWidth,
		body: document.body.scrollWidth
	}));
	layouts.push({ label, ...size });
	assert.equal(size.viewport, 390);
	assert.ok(
		size.document <= size.viewport && size.body <= size.viewport,
		`${label}: horizontal overflow ${JSON.stringify(size)}`
	);
	assert.deepEqual(errors, [], `${label}: JavaScript errors`);
	await page.screenshot({ path: `${output}/${label}.png` });
	screenshots.push(`${output}/${label}.png`);
}
async function counts() {
	const [row] = await db`select
		(select count(*)::int from programs) programs,
		(select count(*)::int from days) days,
		(select count(*)::int from day_exercises) day_exercises,
		(select count(*)::int from prescribed_sets) prescribed_sets,
		(select count(*)::int from exercises) exercises,
		(select count(*)::int from program_draft_requests) requests`;
	return plain(row);
}
async function tree(id: string) {
	return plain({
		program: (await db`select * from programs where id=${id}`)[0],
		days: await db`select * from days where program_id=${id} order by position`,
		exercises:
			await db`select de.* from day_exercises de join days d on d.id=de.day_id where d.program_id=${id} order by d.position,de.position`,
		sets: await db`select ps.* from prescribed_sets ps join day_exercises de on de.id=ps.day_exercise_id join days d on d.id=de.day_id where d.program_id=${id} order by d.position,de.position,ps.position`
	});
}
async function snapshot(id: string) {
	return plain({
		session: (await db`select * from sessions where id=${id}`)[0],
		exercises: await db`select * from session_exercises where session_id=${id} order by id`,
		sets: await db`select * from sets where session_id=${id} order by id`
	});
}
async function reviewSave(label: string, editing = false) {
	assert.equal(
		await button(editing ? 'Save as new version' : 'Save program').count(),
		0,
		'Save must require review'
	);
	await button('Review program').click();
	await page.getByRole('heading', { name: 'Review program', exact: true }).waitFor();
	await checkpoint(`${label}-review`);
	// Capture the actual reviewed form BEFORE submission; never rebuild it from DB.
	const payload = await page.locator('input[name="payload"]').inputValue();
	const requestId = await page.locator('input[name="requestId"]').inputValue();
	const submitUrl = page.url();
	const requestPromise = page.waitForRequest(
		(request) => request.method() === 'POST' && request.url() === submitUrl
	);
	await button(editing ? 'Save as new version' : 'Save program').click();
	const request = await requestPromise;
	const rawBody = request.postData();
	assert.ok(rawBody);
	const sent = new URLSearchParams(rawBody);
	assert.equal(sent.get('payload'), payload);
	assert.equal(sent.get('requestId'), requestId);
	await page.waitForURL(/\/programs\/[0-9a-f-]+$/);
	await settled();
	const programId = page.url().split('/').pop()!;
	const [receipt] = await db`select * from program_draft_requests where request_id=${requestId}`;
	assert.equal(receipt.program_id, programId, 'Browser server and guarded database must agree');
	const before = await counts();
	const replays = await Promise.all(
		[0, 1].map(() =>
			page.request.post(submitUrl, {
				data: rawBody,
				headers: {
					'content-type': request.headers()['content-type'],
					origin,
					referer: submitUrl,
					'sec-fetch-site': 'same-origin',
					accept: 'text/html'
				},
				maxRedirects: 0
			})
		)
	);
	for (const replay of replays) {
		assert.equal(replay.status(), 303, await replay.text());
		assert.equal(replay.headers().location, `/programs/${programId}`);
	}
	assert.deepEqual(await counts(), before, 'Concurrent identical replay must create no rows');
	checks.push(
		`${label}: explicit review, UI save, two concurrent exact POST replays return same ID with no extra rows`
	);
	await checkpoint(`${label}-saved`);
	return { programId, payload, requestId };
}
async function endSession(id: string) {
	await button('End Session').click();
	await page.waitForURL(`${origin}/`);
	await settled();
	const [session] = await db`select * from sessions where id=${id}`;
	assert.ok(session.ended_at, 'UI End Session persisted');
}
async function startDay(programId: string, dayId: string) {
	await page.goto(`${origin}/programs/${programId}`);
	await settled();
	const form = page
		.locator('form[action="?/startSession"]')
		.filter({ has: page.locator(`input[name="dayId"][value="${dayId}"]`) });
	await form.getByRole('button', { name: 'Start', exact: true }).click();
	await page.waitForURL('**/sessions/**');
	await settled();
	const id = page.url().split('/').pop()!;
	const [row] = await db`select * from sessions where id=${id}`;
	assert.equal(row.day_id, dayId);
	assert.equal(row.program_id, programId);
	return id;
}
async function invalidPost(payload: ProgramDraft, url = `${origin}/programs/new`) {
	const before = await counts();
	const response = await page.request.post(url, {
		form: { payload: JSON.stringify(payload), requestId: randomUUID() },
		headers: { origin, referer: url, 'sec-fetch-site': 'same-origin', accept: 'text/html' },
		maxRedirects: 0
	});
	assert.equal(response.status(), 400, await response.text());
	assert.deepEqual(
		await counts(),
		before,
		'Invalid payload must not write any nested/library/receipt rows'
	);
}
try {
	const [identity] = await db`select current_database() name, inet_server_port() port`;
	assert.equal(identity.name, 'builder_browser');
	// Refuse unfamiliar data rather than wiping or reading a real user's logs.
	const [foreign] =
		await db`select count(*)::int n from programs where name not like ${`${prefix}%`}`;
	assert.equal(foreign.n, 0, 'Non-synthetic programs detected: refuse acceptance run');
	const [machines] =
		await db`select (select count(*) from gyms)+(select count(*) from gym_equipment)+(select count(*) from equipment_models) n`;
	assert.equal(Number(machines.n), 0, 'No imported gym or machine fixtures permitted');
	const expectedPreset = travelingPplDraft();
	const permittedNames = expectedPreset.days.flatMap((day) =>
		day.exercises.map((exercise) => exercise.newExercise!.name)
	);
	const libraryBefore = await db`select name from exercises`;
	assert.ok(
		libraryBefore.every(
			(exercise) => exercise.name.startsWith(prefix) || permittedNames.includes(exercise.name)
		),
		'Unknown exercise library: refuse'
	);
	const baseline = await counts();
	ids.baseline = baseline;
	// The sole DB fixture is a synthetic exercise definition for existing-library selection.
	// Every program, day, prescription, session and executed set is created via UI.
	const [existing] =
		await db`insert into exercises(name,equipment_type,is_lower_body) values (${`${name} existing press`},'dumbbell',false) returning id`;
	await page.goto(`${origin}/`);
	await settled();
	await page.getByRole('link', { name: 'Create program', exact: true }).click();
	await settled();
	await button('Start blank draft').click();
	await field('Program name').fill(name);
	await field('Description').fill(
		'Synthetic mobile acceptance only. No imported workouts or gym data.'
	);
	await field('Day 1 name').fill('Synthetic Push');
	await field('Day 1 notes').fill('Synthetic warmup plus top and backoff demonstration.');
	await field('Day 1 exercise 1 library exercise').selectOption(existing.id);
	await field('Day 1 exercise 1 tier').selectOption('main');
	await field('Day 1 exercise 1 set 1 role').selectOption('warmup');
	await button('Add set to day 1 exercise 1').click();
	await field('Day 1 exercise 1 set 2 role').selectOption('top');
	await button('Add set to day 1 exercise 1').click();
	await field('Day 1 exercise 1 set 3 role').selectOption('backoff');
	for (const [index, dayName, exerciseName, equipment, lower] of [
		[2, 'Synthetic Pull', 'quick row', 'cable', 'false'],
		[3, 'Synthetic Legs', 'timed squat hold', 'bodyweight', 'true']
	] as const) {
		await button('Add day').click();
		await field(`Day ${index} name`).fill(dayName);
		await field(`Day ${index} exercise 1 library exercise`).selectOption('new');
		await field(`Day ${index} exercise 1 new exercise name`).fill(`${name} ${exerciseName}`);
		await field(`Day ${index} exercise 1 equipment type`).selectOption(equipment);
		await field(`Day ${index} exercise 1 lower body`).selectOption(lower);
	}
	await field('Day 3 alternate group').fill('synthetic-legs');
	await field('Day 3 exercise 1 set 1 target metric').selectOption('seconds');
	await field('Day 3 exercise 1 set 1 minimum target').fill('20');
	await field('Day 3 exercise 1 set 1 maximum target').fill('30');
	await field('Day 3 exercise 1 set 1 notes').fill(
		'Synthetic seconds target; load intentionally blank.'
	);
	// Exercise add/remove and canonical day/set ordering remain visible operations.
	await button('Add exercise to day 3').click();
	await button('Remove draft day 3 exercise 2').click();
	await button('Move day 3 up').click();
	await button('Move day 2 down').click();
	await button('Move day 1 exercise 1 set 3 up').click();
	await button('Move day 1 exercise 1 set 2 down').click();
	await checkpoint('01-blank-editor');
	const blank = await reviewSave('02-blank');
	ids.originalProgramId = blank.programId;
	const original = await tree(blank.programId);
	assert.equal(original.days.length, 3);
	assert.equal(original.exercises.length, 3);
	assert.deepEqual(
		original.sets.map((set) => set.set_role),
		['warmup', 'top', 'backoff', 'working', 'working']
	);
	assert.equal(original.sets.at(-1)!.target_metric, 'seconds');
	assert.ok(original.sets.every((set) => set.initial_load === null));
	assert.equal(original.exercises[0].exercise_id, existing.id);
	checks.push(
		'Blank three-day PPL: existing library + two quick-adds, explicit lower-body metadata, reps/seconds, MAIN warmup/top/backoff, draft add/remove/reorder'
	);
	await page.goto(`${origin}/`);
	await page.locator(`a[href="/programs/${blank.programId}"]`).waitFor();
	await checkpoint('03-home-blank');
	const sessionId = await startDay(blank.programId, original.days[0].id);
	ids.originalSessionId = sessionId;
	const rows = await db`select * from sets where session_id=${sessionId} order by position`;
	assert.equal(rows.length, 3);
	assert.ok(rows.every((set) => set.prescribed_load === null && set.gym_equipment_id === null));
	const top = rows.find((set) => set.set_role === 'top')!;
	const setForm: Locator = page.locator(`#set-${top.id}`);
	await setForm.locator('[name="executedLoad"]').fill('20');
	await setForm.locator('[name="executedReps"]').fill('10');
	await setForm.locator('[name="executedRir"]').fill('2');
	await setForm.getByRole('button', { name: 'Save', exact: true }).click();
	await setForm.getByText('logged', { exact: true }).waitFor();
	const [logged] = await db`select * from sets where id=${top.id}`;
	assert.equal(Number(logged.executed_load), 20);
	assert.equal(logged.executed_reps, 10);
	await checkpoint('04-blank-logged');
	await endSession(sessionId);
	const oldSnapshot = await snapshot(sessionId);
	assert.ok(oldSnapshot.session.ended_at);
	checks.push(
		'Blank program appears on home; real UI start/log/end persisted with blank cold-start and no machine binding'
	);
	await page.goto(`${origin}/programs/${blank.programId}`);
	await page.getByRole('link', { name: 'Edit program as new version', exact: true }).click();
	await settled();
	await field('Program name').fill(`${name} version 2`);
	await field('Day 1 name').fill('Synthetic Push revised');
	await field('Day 1 exercise 1 set 2 maximum target').fill('15');
	const revised = await reviewSave('05-edited', true);
	ids.newProgramId = revised.programId;
	assert.notEqual(revised.programId, blank.programId);
	const newTree = await tree(revised.programId);
	const oldAfter = await tree(blank.programId);
	assert.equal(oldAfter.program.is_active, false);
	assert.equal(newTree.program.is_active, true);
	assert.equal(newTree.program.source_program_id, blank.programId);
	// Only source activation and update timestamp are allowed to change.
	assert.deepEqual(oldAfter.program, {
		...original.program,
		is_active: false,
		updated_at: oldAfter.program.updated_at
	});
	assert.deepEqual(oldAfter.days, original.days);
	assert.deepEqual(oldAfter.exercises, original.exercises);
	assert.deepEqual(oldAfter.sets, original.sets);
	assert.deepEqual(await snapshot(sessionId), oldSnapshot);
	for (const key of ['days', 'exercises', 'sets'] as const) {
		const oldIds = new Set(original[key].map((row) => row.id));
		assert.ok(
			newTree[key].every((row) => !oldIds.has(row.id)),
			`${key} must have fresh IDs`
		);
	}
	assert.equal(newTree.days[0].name, 'Synthetic Push revised');
	assert.equal(newTree.sets[1].target_reps_max, 15);
	ids.immutableEvidence = {
		oldTreeChildrenSha256: hash({
			days: original.days,
			exercises: original.exercises,
			sets: original.sets
		}),
		endedSessionSha256: hash(oldSnapshot)
	};
	await page.goto(`${origin}/`);
	await page.locator(`a[href="/programs/${revised.programId}"]`).waitFor();
	assert.equal(await page.locator(`a[href="/programs/${blank.programId}"]`).count(), 0);
	await page.goto(`${origin}/sessions/${sessionId}`);
	await checkpoint('06-ended-unchanged');
	checks.push(
		'UI version save deep-copies every child ID, archives only source, preserves exact source children and ended session/occurrence/set snapshot'
	);
	const invalid = JSON.parse(blank.payload) as ProgramDraft;
	invalid.days[0].exercises[0].sets[0].targetRepsMax = 0;
	await invalidPost(invalid);
	const invalidReference = JSON.parse(blank.payload) as ProgramDraft;
	invalidReference.name = `${name} rejected`;
	invalidReference.days[0].exercises[0].exerciseId = null;
	invalidReference.days[0].exercises[0].newExercise = {
		name: `${name} rolled-back quickadd`,
		equipmentType: 'cable',
		isLowerBody: false
	};
	invalidReference.days[1].exercises[0].newExercise = null;
	invalidReference.days[1].exercises[0].exerciseId = randomUUID();
	await invalidPost(invalidReference);
	const beforeFailedEdit = await tree(revised.programId);
	await invalidPost(invalidReference, `${origin}/programs/${revised.programId}/edit`);
	assert.deepEqual(await tree(revised.programId), beforeFailedEdit);
	checks.push(
		'Invalid nested range POST = 400; missing nested UUID rolls back quickadd/tree/receipt; failed edit preserves active source'
	);
	await page.goto(`${origin}/`);
	await page.getByRole('link', { name: 'Create program', exact: true }).click();
	await settled();
	const beforeChoosing = await counts();
	await button('Use Traveling PPL preset').click();
	assert.equal(await field('Program name').inputValue(), 'Traveling PPL');
	assert.equal(
		await page
			.locator('section[aria-label^="Day "]')
			.filter({ has: page.locator('h2') })
			.count(),
		4
	);
	assert.deepEqual(await counts(), beforeChoosing, 'Choosing preset must not save');
	await field('Program name').fill(`${name} Traveling PPL`);
	await field('Day 1 notes').fill(`${expectedPreset.days[0].notes} Synthetic browser inspection.`);
	const presetDraft = JSON.parse(
		await page.locator('input[name="payload"]').inputValue()
	) as ProgramDraft;
	assert.equal(presetDraft.days.length, 4);
	assert.ok(
		presetDraft.days
			.flatMap((day) => day.exercises.flatMap((exercise) => exercise.sets))
			.every((set) => set.initialLoad === null)
	);
	await page.evaluate(() => window.scrollTo(0, 0));
	await checkpoint('07-preset-editor');
	const preset = await reviewSave('08-preset');
	ids.presetProgramId = preset.programId;
	const presetTree = await tree(preset.programId);
	assert.equal(presetTree.program.is_active, true);
	assert.equal(
		(await tree(revised.programId)).program.is_active,
		true,
		'Creating unrelated program must not archive an existing program'
	);
	assert.deepEqual(
		presetTree.days.map((day) => day.name),
		['Push', 'Pull', 'Legs A - Deadlift', 'Legs B - Machines']
	);
	assert.deepEqual(
		presetTree.days.map((day) => day.alternate_group_id),
		[null, null, 'legs', 'legs']
	);
	const prescribedExpected = expectedPreset.days.map((day) =>
		day.exercises.reduce((sum, exercise) => sum + exercise.sets.length, 0)
	);
	const exerciseCountsExpected = expectedPreset.days.map((day) => day.exercises.length);
	ids.presetExpectedSetsPerDay = prescribedExpected;
	assert.deepEqual(exerciseCountsExpected, [5, 6, 5, 5]);
	assert.equal(
		presetTree.sets.length,
		prescribedExpected.reduce((sum, n) => sum + n, 0)
	);
	assert.ok(
		presetTree.sets.every((set) => set.initial_load === null && set.set_role === 'working')
	);
	const presetSessions: string[] = [];
	for (let index = 0; index < presetTree.days.length; index++) {
		const day = presetTree.days[index];
		const actualExercises =
			await db`select de.*, e.name from day_exercises de join exercises e on e.id=de.exercise_id where de.day_id=${day.id} order by de.position`;
		assert.deepEqual(
			actualExercises.map((exercise) => exercise.name),
			expectedPreset.days[index].exercises.map((exercise) => exercise.newExercise!.name)
		);
		assert.equal(
			actualExercises.length,
			exerciseCountsExpected[index],
			'No forced optional exercises'
		);
		const id = await startDay(preset.programId, day.id);
		presetSessions.push(id);
		const sets = await db`select * from sets where session_id=${id}`;
		const occurrences = await db`select * from session_exercises where session_id=${id}`;
		assert.equal(sets.length, prescribedExpected[index]);
		assert.equal(occurrences.length, exerciseCountsExpected[index]);
		assert.ok(
			sets.every(
				(set) =>
					set.prescribed_load === null &&
					set.executed_load === null &&
					set.gym_equipment_id === null
			)
		);
		assert.ok(occurrences.every((exercise) => exercise.gym_equipment_id === null));
		const loadInputs = await page
			.locator('input[name="executedLoad"]')
			.evaluateAll((elements) => elements.map((element) => (element as HTMLInputElement).value));
		assert.equal(loadInputs.length, prescribedExpected[index]);
		assert.ok(
			loadInputs.every((value) => value === ''),
			'Visible cold-start load inputs must be blank'
		);
		await checkpoint(`09-preset-day-${index + 1}`);
		await endSession(id);
	}
	ids.presetSessionIds = presetSessions;
	assert.equal(presetSessions.length, 4);
	const [ended] =
		await db`select count(*)::int n from sessions where program_id=${preset.programId} and ended_at is not null`;
	assert.equal(ended.n, 4);
	assert.deepEqual(await snapshot(sessionId), oldSnapshot);
	checks.push(
		'Traveling PPL UI choose/edit/review/save: four ordered days, legs alternation, exact required exercises only, blank initial loads'
	);
	checks.push(
		'All four preset days started and ended through UI; real occurrence/set counts match preset; visible loads and machine IDs stay blank'
	);
	await checkpoint('10-final-home');
	assert.deepEqual(errors, []);
	checks.push(
		'390x844 mobile checkpoints: no horizontal overflow and no JavaScript/console errors; zero imported log rows; no production writes or deployment'
	);
	const result = {
		passed: true,
		origin,
		database: allowedDatabase,
		viewport: { width: 390, height: 844 },
		syntheticOnly: true,
		importedLogRows: 0,
		checks,
		ids,
		layouts,
		errors,
		screenshots
	};
	await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} catch (error) {
	const failure = error instanceof Error ? error.stack : String(error);
	await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
	await writeFile(
		`${output}/result.json`,
		JSON.stringify(
			{ passed: false, failure, url: page.url(), checks, ids, layouts, errors, screenshots },
			null,
			2
		)
	);
	console.error(failure);
	console.error((await page.locator('body').innerText()).slice(-12000));
	process.exitCode = 1;
} finally {
	await browser.close();
	await db.end();
}
