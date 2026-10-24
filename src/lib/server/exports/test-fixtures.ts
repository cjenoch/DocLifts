import type { TestDb } from '../test-db';
import * as s from '../db/schema';

/** Fictional, intentionally unequal values across prescription/execution and owners. */
export async function seedExportFixture(db: TestDb, userId: string, label: string, load = 100) {
	const [program] = await db
		.insert(s.programs)
		.values({ userId, name: label + ' program', isActive: false, description: 'Original version' })
		.returning();
	const [day] = await db
		.insert(s.days)
		.values({ programId: program.id, name: label + ' day', position: 1, notes: 'Day notes' })
		.returning();
	const [exercise] = await db
		.insert(s.exercises)
		.values({
			userId,
			name: label + ' current name',
			equipmentType: 'machine-plate',
			notes: 'Exercise notes',
			archivedAt: new Date()
		})
		.returning();
	const [dx] = await db
		.insert(s.dayExercises)
		.values({
			dayId: day.id,
			exerciseId: exercise.id,
			position: 1,
			tier: 'main',
			progressionPolicy: 'hold',
			notes: 'Template notes'
		})
		.returning();
	const [prescription] = await db
		.insert(s.prescribedSets)
		.values({
			dayExerciseId: dx.id,
			position: 1,
			setRole: 'top',
			targetMetric: 'reps',
			targetRepsMin: 3,
			targetRepsMax: 5,
			targetRir: 2,
			initialLoad: 10,
			notes: 'Template set'
		})
		.returning();
	const [gym] = await db
		.insert(s.gyms)
		.values({ userId, name: label + ' gym', archivedAt: new Date() })
		.returning();
	const [model] = await db
		.insert(s.equipmentModels)
		.values({
			manufacturer: 'Fixture',
			name: label + ' owned model',
			loadingType: 'plate',
			ownerUserId: userId,
			notes: label + ' model note'
		})
		.returning();
	const [global] = await db
		.insert(s.equipmentModels)
		.values({
			manufacturer: 'Fixture',
			name: label + ' public catalog',
			loadingType: 'plate',
			retiredAt: new Date()
		})
		.returning();
	const [machine, oldMachine] = await db
		.insert(s.gymEquipment)
		.values([
			{
				gymId: gym.id,
				equipmentModelId: global.id,
				localLabel: label + ' machine',
				equipmentType: 'machine-plate'
			},
			{
				gymId: gym.id,
				equipmentModelId: model.id,
				localLabel: label + ' old machine',
				equipmentType: 'machine-plate',
				archivedAt: new Date()
			}
		])
		.returning();
	await db
		.insert(s.exerciseEquipmentMap)
		.values({ exerciseId: exercise.id, equipmentModelId: global.id });
	const start = new Date('2026-06-10T01:30:00Z'),
		end = new Date('2026-06-10T02:01:30Z');
	const [ended, open, trash, empty] = await db
		.insert(s.sessions)
		.values([
			{
				userId,
				dayId: day.id,
				programId: program.id,
				startedAt: start,
				endedAt: end,
				notes: label + ' workout notes'
			},
			{ userId, dayId: day.id, programId: program.id, startedAt: new Date('2026-06-11T12:00:00Z') },
			{
				userId,
				dayId: day.id,
				programId: program.id,
				startedAt: start,
				endedAt: end,
				deletedAt: end
			},
			{
				userId,
				dayId: day.id,
				programId: program.id,
				startedAt: new Date('2026-06-12T12:00:00Z'),
				endedAt: new Date('2026-06-12T13:00:00Z')
			}
		])
		.returning();
	const [occurrence] = await db
		.insert(s.sessionExercises)
		.values({
			sessionId: ended.id,
			exerciseId: exercise.id,
			gymEquipmentId: machine.id,
			position: 1,
			exerciseName: label + ' historical name',
			machineLabel: label + ' historical machine',
			gymName: label + ' historical gym',
			equipmentType: 'machine-plate',
			loadConvention: 'plates_per_side',
			tier: 'main',
			progressionPolicy: 'hold'
		})
		.returning();
	const [logged] = await db
		.insert(s.sets)
		.values([
			{
				userId,
				sessionId: ended.id,
				exerciseId: exercise.id,
				sessionExerciseId: occurrence.id,
				gymEquipmentId: machine.id,
				loadConvention: 'plates_per_side',
				prescribedSetId: prescription.id,
				position: 1,
				setRole: 'top',
				prescribedLoad: 999,
				prescribedRepsMin: 3,
				prescribedRepsMax: 5,
				prescribedRir: 2,
				executedLoad: load,
				executedReps: 5,
				executedRir: 1,
				notes: '=1+1, "quoted"\n' + label
			},
			{
				userId,
				sessionId: ended.id,
				exerciseId: exercise.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'seconds',
				loadConvention: 'displayed',
				executedLoad: 0,
				executedReps: 30
			},
			{
				userId,
				sessionId: ended.id,
				exerciseId: exercise.id,
				position: 3,
				setRole: 'backoff',
				prescribedLoad: 777
			},
			{
				userId,
				sessionId: ended.id,
				exerciseId: exercise.id,
				position: 4,
				setRole: 'warmup',
				executedLoad: 0,
				executedReps: 0
			},
			{
				userId,
				sessionId: open.id,
				exerciseId: exercise.id,
				position: 1,
				setRole: 'working',
				executedLoad: 20,
				executedReps: 6
			},
			{
				userId,
				sessionId: trash.id,
				exerciseId: exercise.id,
				position: 1,
				setRole: 'working',
				executedLoad: 30,
				executedReps: 7
			}
		])
		.returning();
	await db.insert(s.painEvents).values({
		userId,
		setId: logged.id,
		location: label + ' shoulder',
		severity: 2,
		notes: label + ' health note'
	});
	const importId = crypto.randomUUID();
	await db.insert(s.workoutLogImports).values({
		id: importId,
		userId,
		sourceSha256: label,
		sourceName: label + '.txt',
		sourceText: label + ' exact source\n=not a formula'
	});
	await db.insert(s.importedWorkouts).values({
		id: crypto.randomUUID(),
		importId,
		sourceLine: 1,
		title: label + ' notebook',
		workoutDate: null,
		earliestDate: '2020-01-01',
		latestDate: '2020-01-31',
		dateNote: 'Uncertain day',
		lines: [
			{
				sourceLine: 2,
				text: 'Dumbbell notes',
				loadConvention: 'per_arm',
				interpretationNote: 'Recalled estimate',
				sets: [{ load: 55, reps: 8, evidence: 'user_authorized_estimate' }]
			},
			{
				sourceLine: 3,
				text: 'Unstructured note',
				loadConvention: 'unknown',
				interpretationNote: null,
				sets: []
			}
		]
	});
	const [llm] = await db
		.insert(s.llmCalls)
		.values({
			userId,
			purpose: 'fixture',
			provider: 'test',
			model: 'test',
			status: 'ok',
			latencyMs: 0,
			promptHash: '0'.repeat(64),
			promptText: label + ' prompt',
			output: { text: label + ' model output' }
		})
		.returning();
	const [photo] = await db
		.insert(s.equipmentPhotos)
		.values({
			userId,
			gymId: gym.id,
			storageKey: 'private-object-' + label,
			contentType: 'image/jpeg',
			bytes: 12,
			width: 1,
			height: 1,
			sha256: 'a'.repeat(64),
			status: 'confirmed',
			llmCallId: llm.id,
			matchedModelId: global.id,
			createdModelId: model.id,
			gymEquipmentId: machine.id,
			sessionExerciseId: occurrence.id,
			candidate: { name: label + ' identification' }
		})
		.returning();
	await db.insert(s.machineMerges).values({
		userId,
		droppedId: oldMachine.id,
		keptId: machine.id,
		moved: { sets: [logged.id], sessionExercises: [occurrence.id], photos: [photo.id] },
		undoneAt: new Date()
	});
	return { program, day, exercise, ended, open, trash, empty, logged, model, global, photo };
}
