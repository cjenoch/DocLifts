/** Only live work is retained: no unbounded per-account counter history. */
export function createExportGate(maximum = 2) {
	const active = new Set<string>();
	return (userId: string) => {
		if (active.size >= maximum || active.has(userId)) return null;
		active.add(userId);
		return () => {
			active.delete(userId);
		};
	};
}
export const enterExport = createExportGate();
