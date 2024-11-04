import { binarySearch } from './binarySearch';
import { translateOffset } from './translateOffset';

type CodeRangeKey = 'sourceOffsets' | 'generatedOffsets';

export interface Mapping<Data = unknown> {
	sourceOffsets: number[];
	generatedOffsets: number[];
	lengths: number[];
	generatedLengths?: number[];
	data: Data;
}

interface MappingMemo<Data> {
	offsets: number[];
	mappings: Set<Mapping<Data>>[];
}

export class SourceMap<Data = unknown> {

	private sourceCodeOffsetsMemo: MappingMemo<Data> | undefined;
	private generatedCodeOffsetsMemo: MappingMemo<Data> | undefined;

	constructor(public readonly mappings: Mapping<Data>[]) { }

	toSourceRange(generatedStart: number, generatedEnd: number, fallbackToAnyMatch: boolean, filter?: (data: Data) => boolean) {
		return this.findMatchingStartEnd(generatedStart, generatedEnd, fallbackToAnyMatch, 'generatedOffsets', filter);
	}

	toGeneratedRange(sourceStart: number, sourceEnd: number, fallbackToAnyMatch: boolean, filter?: (data: Data) => boolean) {
		return this.findMatchingStartEnd(sourceStart, sourceEnd, fallbackToAnyMatch, 'sourceOffsets', filter);
	}

	toSourceLocation(generatedOffset: number, filter?: (data: Data) => boolean) {
		return this.findMatchingOffsets(generatedOffset, 'generatedOffsets', filter);
	}

	toGeneratedLocation(sourceOffset: number, filter?: (data: Data) => boolean) {
		return this.findMatchingOffsets(sourceOffset, 'sourceOffsets', filter);
	}

	* findMatchingOffsets(offset: number, fromRange: CodeRangeKey, filter?: (data: Data) => boolean) {
		const memo = this.getMemoBasedOnRange(fromRange);
		if (memo.offsets.length === 0) {
			return;
		}

		const { low: start, high: end } = binarySearch(memo.offsets, offset);
		const skip = new Set<Mapping>();
		const toRange: CodeRangeKey = fromRange == 'sourceOffsets' ? 'generatedOffsets' : 'sourceOffsets';

		for (let i = start; i <= end; i++) {
			for (const mapping of memo.mappings[i]) {
				if (skip.has(mapping)) {
					continue;
				}
				skip.add(mapping);

				if (filter && !filter(mapping.data)) {
					continue;
				}

				const mapped = translateOffset(offset, mapping[fromRange], mapping[toRange], getLengths(mapping, fromRange), getLengths(mapping, toRange));
				if (mapped !== undefined) {
					yield [mapped, mapping] as const;
				}
			}
		}
	}

	* findMatchingStartEnd(
		start: number,
		end: number,
		fallbackToAnyMatch: boolean,
		fromRange: CodeRangeKey,
		filter?: (data: Data) => boolean
	): Generator<[mappedStart: number, mappedEnd: number, startMapping: Mapping<Data>, endMapping: Mapping<Data>]> {
		const toRange: CodeRangeKey = fromRange == 'sourceOffsets' ? 'generatedOffsets' : 'sourceOffsets';
		const mappedStarts: [number, Mapping<Data>][] = [];
		let hadMatch = false;
		for (const [mappedStart, mapping] of this.findMatchingOffsets(start, fromRange)) {
			if (filter && !filter(mapping.data)) {
				continue;
			}
			mappedStarts.push([mappedStart, mapping]);
			const mappedEnd = translateOffset(end, mapping[fromRange], mapping[toRange], getLengths(mapping, fromRange), getLengths(mapping, toRange));
			if (mappedEnd !== undefined) {
				hadMatch = true;
				yield [mappedStart, mappedEnd, mapping, mapping] as const;
			}
		}
		if (!hadMatch && fallbackToAnyMatch) {
			for (const [mappedStart, mappingStart] of mappedStarts) {
				for (const [mappedEnd, mappingEnd] of this.findMatchingOffsets(end, fromRange)) {
					if (filter && !filter(mappingEnd.data) || mappedEnd < mappedStart) {
						continue;
					}
					yield [mappedStart, mappedEnd, mappingStart, mappingEnd] as const;
					break;
				};
			}
		}
	}

	private getMemoBasedOnRange(fromRange: CodeRangeKey) {
		return fromRange === 'sourceOffsets'
			? this.sourceCodeOffsetsMemo ??= this.createMemo('sourceOffsets')
			: this.generatedCodeOffsetsMemo ??= this.createMemo('generatedOffsets');
	}

	private createMemo(key: CodeRangeKey): MappingMemo<Data> {
		const offsetsSet = new Set<number>();
		for (const mapping of this.mappings) {
			for (let i = 0; i < mapping[key].length; i++) {
				offsetsSet.add(mapping[key][i]);
				offsetsSet.add(mapping[key][i] + getLengths(mapping, key)[i]);
			}
		}

		const offsets = [...offsetsSet].sort((a, b) => a - b);
		const mappings = offsets.map(() => new Set<Mapping<Data>>());

		for (const mapping of this.mappings) {
			for (let i = 0; i < mapping[key].length; i++) {
				const startIndex = binarySearch(offsets, mapping[key][i]).match!;
				const endIndex = binarySearch(offsets, mapping[key][i] + getLengths(mapping, key)[i]).match!;
				for (let i = startIndex; i <= endIndex; i++) {
					mappings[i].add(mapping);
				}
			}
		}

		return { offsets, mappings };
	}
}

function getLengths(mapping: Mapping, key: CodeRangeKey) {
	return key == 'sourceOffsets' ? mapping.lengths : mapping.generatedLengths ?? mapping.lengths;
}
