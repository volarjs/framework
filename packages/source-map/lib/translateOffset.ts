export function translateOffset(start: number, fromOffsets: number[], toOffsets: number[], fromLengths: number[], toLengths: number[] = fromLengths): number | undefined {
	if (!areRangesSortedAndNonOverlapping(fromOffsets, fromLengths)) {
		throw new Error('fromOffsets must be sorted in ascending order and ranges cannot overlap');
	}

	let low = 0;
	let high = fromOffsets.length - 1;

	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const fromOffset = fromOffsets[mid];
		const fromLength = fromLengths[mid];

		if (start >= fromOffset && start <= fromOffset + fromLength) {
			const toLength = toLengths[mid];
			const toOffset = toOffsets[mid];
			let rangeOffset = Math.min(start - fromOffset, toLength);
			return toOffset + rangeOffset;
		} else if (start < fromOffset) {
			high = mid - 1;
		} else {
			low = mid + 1;
		}
	}
}

export function areRangesSortedAndNonOverlapping(offsets: number[], lenghts: number[]): boolean {
	let lastEnd = 0
	for (let i = 0; i < offsets.length; i++) {
		if (offsets[i] < lastEnd) {
			return false
		}
		lastEnd = offsets[i] + lenghts[i]
	}
	return true
}
