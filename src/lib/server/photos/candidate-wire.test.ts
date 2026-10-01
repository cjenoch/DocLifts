import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CANDIDATE_WIRE_SCHEMA, EquipmentCandidate } from './analyze';

/**
 * The model is sent CANDIDATE_WIRE_SCHEMA and its reply is validated by
 * EquipmentCandidate (0.4.4). They must describe the same object: a field
 * added to one and not the other is a field the model is never asked for, or
 * one it is asked for and the app throws away.
 */
describe('CANDIDATE_WIRE_SCHEMA', () => {
	const derived = z.toJSONSchema(EquipmentCandidate, { io: 'output' }) as {
		properties: Record<string, { enum?: string[]; properties?: Record<string, unknown> }>;
	};
	const wire = CANDIDATE_WIRE_SCHEMA.properties as Record<
		string,
		{ enum?: readonly string[]; properties?: Record<string, unknown> }
	>;

	it('asks for exactly the fields the zod schema keeps, and requires them all', () => {
		expect(Object.keys(wire).sort()).toEqual(Object.keys(derived.properties).sort());
		expect([...CANDIDATE_WIRE_SCHEMA.required].sort()).toEqual(Object.keys(wire).sort());
		expect(Object.keys(wire.field_confidence.properties!).sort()).toEqual(
			Object.keys(derived.properties.field_confidence.properties!).sort()
		);
	});

	it('offers the same allowed values for the enums', () => {
		for (const k of ['loading_type', 'laterality']) {
			expect([...(wire[k].enum ?? [])].sort(), k).toEqual(
				[...(derived.properties[k].enum ?? [])].sort()
			);
		}
	});

	it('carries none of the constraints that made strict output slow', () => {
		const text = JSON.stringify(CANDIDATE_WIRE_SCHEMA);
		for (const keyword of ['maxLength', 'minimum', 'maximum', 'default', 'anyOf']) {
			expect(text, keyword).not.toContain(keyword);
		}
	});
});
