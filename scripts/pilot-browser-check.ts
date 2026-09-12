import { chromium } from 'playwright';
import postgres from 'postgres';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const url = process.env.DATABASE_URL;
if (url !== 'postgresql://postgres@127.0.0.1:55439/doclifts_pilot')
	throw new Error('Isolated synthetic DB only');
const db = postgres(url, { max: 1 });
const output = '/home/chris/.hermes/kanban/workspaces/t_ec638eb4/browser-evidence';
await mkdir(output, { recursive: true });
const suffix = Date.now().toString();
const [program] =
	await db`insert into programs(name) values (${`Browser pilot ${suffix}`}) returning id`;
const [day] =
	await db`insert into days(program_id,name,position) values (${program.id},'Browser day',1) returning id`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
try {
	await page.goto('http://127.0.0.1:5179/');
	await page.waitForLoadState('networkidle');
	await page.getByRole('link', { name: 'Gyms and machines', exact: true }).click();
	await page.waitForLoadState('networkidle');
	await page.locator('input[name="name"]').fill(`Browser gym ${suffix}`);
	await page.getByRole('button', { name: 'Create gym', exact: true }).click();
	await page.getByRole('status').waitFor();
	const [gym] = await db`select id from gyms where name=${`Browser gym ${suffix}`}`;
	assert.ok(gym);
	const machineForm = page.locator('form[action="?/createMachine"]');
	await machineForm.locator('[name="gymId"]').selectOption(gym.id);
	await machineForm.locator('[name="localLabel"]').fill(`Unknown press ${suffix}`);
	await machineForm.locator('[name="equipmentType"]').selectOption('machine-plate');
	await page.getByRole('button', { name: 'Add machine', exact: true }).click();
	await page.getByRole('status').filter({ hasText: 'Machine created' }).waitFor();
	const [machine] = await db`select * from gym_equipment where gym_id=${gym.id}`;
	assert.equal(machine.equipment_model_id, null);
	await page.screenshot({ path: `${output}/01-unknown-machine.png`, fullPage: true });
	await page.goto(`http://127.0.0.1:5179/programs/${program.id}`);
	await page.locator('form[action="?/startSession"] button').click();
	await page.waitForURL('**/sessions/**');
	await page.waitForLoadState('networkidle');
	const sessionId = page.url().split('/').pop()!;
	await page.getByText('Quick-add to this workout only', { exact: true }).click();
	const add = page.locator('form[action="?/addExercise"]');
	await add.locator('[name="exerciseName"]').fill(`Browser press ${suffix}`);
	await add.locator('[name="canonicalMovement"]').fill('chest_press');
	await add.getByLabel('Gym', { exact: true }).selectOption(gym.id);
	await add.getByLabel('Machine', { exact: true }).selectOption(machine.id);
	await add.getByLabel('Load convention', { exact: true }).selectOption('total_plates');
	await add.getByRole('button', { name: 'Add exercise to workout', exact: true }).click();
	await page.getByRole('heading', { name: `Browser press ${suffix}`, exact: true }).waitFor();
	let rows = await db`select * from sets where session_id=${sessionId} order by position`;
	assert.equal(rows.length, 2);
	assert.equal(rows[0].prescribed_load, null);
	assert.equal(rows[0].load_convention, 'total_plates');
	const first = page.locator(`#set-${rows[0].id}`);
	await first.locator('[name="executedLoad"]').fill('103');
	await first.locator('[name="executedReps"]').fill('12');
	await first.locator('[name="executedRir"]').fill('1');
	await first.getByRole('button', { name: 'Save', exact: true }).click();
	await first.getByText('logged', { exact: true }).waitFor();
	rows = await db`select * from sets where session_id=${sessionId} order by position`;
	assert.equal(Number(rows[0].executed_load), 103);
	await page.screenshot({ path: `${output}/02-logged-identity.png`, fullPage: true });
	await page.getByText('Select / change machine', { exact: true }).click();
	const bind = page.locator('form[action="?/bindMachine"]');
	await bind.getByLabel('Gym', { exact: true }).selectOption(gym.id);
	await bind.getByLabel('Machine', { exact: true }).selectOption(machine.id);
	await bind.getByLabel('Load convention', { exact: true }).selectOption('plates_per_side');
	await bind.locator('[name="confirm"]').check();
	await bind.getByRole('button', { name: 'Apply machine' }).click();
	await page.getByRole('alert').filter({ hasText: 'logged' }).waitFor();
	await page.screenshot({ path: `${output}/03-switch-rejected.png`, fullPage: true });
	await page.getByRole('button', { name: 'End Session', exact: true }).click();
	await page.waitForURL('http://127.0.0.1:5179/');
	await db`update gym_equipment set local_label='Renamed after logging' where id=${machine.id}`;
	await page.goto(`http://127.0.0.1:5179/sessions/${sessionId}`);
	assert.ok((await page.locator('body').innerText()).includes(`Unknown press ${suffix}`));
	assert.equal(await page.getByText('Renamed after logging', { exact: true }).count(), 0);
	await page.screenshot({ path: `${output}/04-ended-snapshot.png`, fullPage: true });
	await page.goto('http://127.0.0.1:5179/reports');
	assert.ok((await page.locator('body').innerText()).includes('total plates'));
	assert.equal(errors.length, 0, errors.join('\n'));
	const report = {
		passed: true,
		sessionId,
		programId: program.id,
		checks: [
			'home-to-gym navigation',
			'gym create',
			'unknown-model machine create',
			'active session quick-add',
			'exact 103 total plates persistence',
			'post-log switching rejected',
			'ended snapshot survives rename',
			'identity in reports',
			'no browser page errors'
		],
		screenshots: [
			'01-unknown-machine.png',
			'02-logged-identity.png',
			'03-switch-rejected.png',
			'04-ended-snapshot.png'
		]
	};
	await writeFile(`${output}/result.json`, JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
} catch (error) {
	console.log('Page errors:', errors);
	console.log((await page.locator('body').innerText()).slice(-12000));
	await page.screenshot({ path: `${output}/failure.png`, fullPage: true });
	throw error;
} finally {
	await browser.close();
	await db.end();
}
