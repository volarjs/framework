import { SourceMap } from '@volar/source-map';
import type * as ts from 'typescript';
import { LinkedCodeMap } from './linkedCodeMap';
import type { CodeInformation, LanguagePlugin, SourceFile, VirtualCode } from './types';
import { FileMap } from './utils';

export type FileRegistry = ReturnType<typeof createFileRegistry>;

export function createFileRegistry(languagePlugins: LanguagePlugin[], caseSensitive: boolean, sync: (id: string) => void) {

	const sourceFiles = new FileMap<SourceFile>(caseSensitive);
	const virtualCodeToSourceFileMap = new WeakMap<VirtualCode, SourceFile>();
	const virtualCodeToMaps = new WeakMap<ts.IScriptSnapshot, Map<string, [ts.IScriptSnapshot, SourceMap<CodeInformation>]>>();
	const virtualCodeToLinkedCodeMap = new WeakMap<ts.IScriptSnapshot, LinkedCodeMap | undefined>();

	return {
		languagePlugins,
		set(id: string, languageId: string, snapshot: ts.IScriptSnapshot, plugins = languagePlugins): SourceFile {

			const value = sourceFiles.get(id);
			if (value) {
				if (value.languageId !== languageId) {
					// languageId changed
					this.delete(id);
					return this.set(id, languageId, snapshot);
				}
				else if (value.snapshot !== snapshot) {
					// snapshot updated
					value.snapshot = snapshot;
					if (value.generated) {
						value.generated.code = value.generated.languagePlugin.updateVirtualCode(id, value.generated.code, snapshot, this);
						for (const code of forEachEmbeddedCode(value.generated.code)) {
							virtualCodeToSourceFileMap.set(code, value);
						}
					}
					return value;
				}
				else {
					// not changed
					return value;
				}
			}

			// created
			const sourceFile: SourceFile = { id, languageId, snapshot };
			sourceFiles.set(id, sourceFile);

			for (const languagePlugin of plugins) {
				const virtualCode = languagePlugin.createVirtualCode(id, languageId, snapshot, this);
				if (virtualCode) {
					sourceFile.generated = {
						code: virtualCode,
						languagePlugin,
					};
					for (const code of forEachEmbeddedCode(virtualCode)) {
						virtualCodeToSourceFileMap.set(code, sourceFile);
					}
					break;
				}
			}

			return sourceFile;
		},
		delete(id: string) {
			const value = sourceFiles.get(id);
			if (value) {
				if (value.generated) {
					value.generated.languagePlugin.disposeVirtualCode?.(id, value.generated.code, this);
				}
				sourceFiles.delete(id);
			}
		},
		get(id: string) {
			sync(id);
			return sourceFiles.get(id);
		},
		getByVirtualCode(virtualCode: VirtualCode) {
			return virtualCodeToSourceFileMap.get(virtualCode)!;
		},
		getLinkedCodeMap(virtualCode: VirtualCode) {
			if (!virtualCodeToLinkedCodeMap.has(virtualCode.snapshot)) {
				virtualCodeToLinkedCodeMap.set(
					virtualCode.snapshot,
					virtualCode.linkedCodeMappings
						? new LinkedCodeMap(virtualCode.linkedCodeMappings)
						: undefined
				);
			}
			return virtualCodeToLinkedCodeMap.get(virtualCode.snapshot);
		},
		getMaps(virtualCode: VirtualCode) {

			if (!virtualCodeToMaps.has(virtualCode.snapshot)) {
				virtualCodeToMaps.set(virtualCode.snapshot, new Map());
			}

			updateVirtualCodeMaps(virtualCode, sourceFileId => {
				if (sourceFileId) {
					const sourceFile = sourceFiles.get(sourceFileId)!;
					return [sourceFileId, sourceFile.snapshot];
				}
				else {
					const sourceFile = virtualCodeToSourceFileMap.get(virtualCode)!;
					return [sourceFile.id, sourceFile.snapshot];
				}
			}, virtualCodeToMaps.get(virtualCode.snapshot));

			return virtualCodeToMaps.get(virtualCode.snapshot)!;
		},
		getVirtualCode(sourceFileId: string, virtualCodeId: string) {
			const sourceFile = this.get(sourceFileId);
			if (sourceFile?.generated) {
				for (const code of forEachEmbeddedCode(sourceFile.generated.code)) {
					if (code.id === virtualCodeId) {
						return [code, sourceFile] as const;
					}
				}
			}
			return [undefined, undefined] as const;
		},
	};
}

export function updateVirtualCodeMaps(
	virtualCode: VirtualCode,
	getSourceSnapshot: (sourceUri: string | undefined) => [string, ts.IScriptSnapshot] | undefined,
	map: Map<string, [ts.IScriptSnapshot, SourceMap<CodeInformation>]> = new Map(),
) {

	const sources = new Set<string | undefined>();

	for (const mapping of virtualCode.mappings) {

		if (sources.has(mapping.source)) {
			continue;
		}
		sources.add(mapping.source);

		const source = getSourceSnapshot(mapping.source);
		if (!source) {
			continue;
		}

		if (!map.has(source[0]) || map.get(source[0])![0] !== source[1]) {
			map.set(source[0], [source[1], new SourceMap(virtualCode.mappings.filter(mapping2 => mapping2.source === mapping.source))]);
		}
	}

	return map;
}

export function* forEachEmbeddedCode(code: VirtualCode): Generator<VirtualCode> {
	yield code;
	if (code.embeddedCodes) {
		for (const embeddedCode of code.embeddedCodes) {
			yield* forEachEmbeddedCode(embeddedCode);
		}
	}
}
