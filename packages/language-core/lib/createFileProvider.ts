import { SourceMap } from '@volar/source-map';
import type * as ts from 'typescript/lib/tsserverlibrary';
import { MirrorMap } from './mirrorMap';
import type { FileRangeCapabilities, Language, SourceFile, VirtualFile } from './types';

const caseSensitive = false; // TODO: use ts.sys.useCaseSensitiveFileNames

export function createFileProvider(languages: Language[], sync: (sourceFileId: string) => void) {

	const sourceFileRegistry = new Map<string, SourceFile>();
	const virtualFileRegistry = new Map<string, { virtualFile: VirtualFile, source: SourceFile; }>();
	const virtualFileMaps = new WeakMap<ts.IScriptSnapshot, Map<string, [ts.IScriptSnapshot, SourceMap<FileRangeCapabilities>]>>();
	const virtualFileToMirrorMap = new WeakMap<ts.IScriptSnapshot, MirrorMap | undefined>();
	const normalizeId = caseSensitive
		? (id: string) => id
		: (id: string) => id.toLowerCase();

	return {
		updateSourceFile(id: string, snapshot: ts.IScriptSnapshot, languageId: string): SourceFile {

			const value = sourceFileRegistry.get(normalizeId(id));
			if (value) {
				if (value.languageId !== languageId) {
					// languageId changed
					this.deleteSourceFile(id);
					return this.updateSourceFile(id, snapshot, languageId);
				}
				else if (value.snapshot !== snapshot) {
					// updated
					value.snapshot = snapshot;
					if (value.root && value.language) {
						deleteVirtualFiles(value);
						value.language.updateVirtualFile(value.root, snapshot);
						updateVirtualFiles(value);
					}
					return value;
				}
				else {
					// not changed
					return value;
				}
			}

			for (const language of languages) {
				const virtualFile = language.createVirtualFile(id, languageId, snapshot);
				if (virtualFile) {
					// created
					const source: SourceFile = { id: id, languageId, snapshot, root: virtualFile, language };
					sourceFileRegistry.set(normalizeId(id), source);
					updateVirtualFiles(source);
					return source;
				}
			}

			const source: SourceFile = { id: id, languageId, snapshot };
			sourceFileRegistry.set(normalizeId(id), source);
			return source;
		},
		deleteSourceFile(id: string) {
			const value = sourceFileRegistry.get(normalizeId(id));
			if (value) {
				if (value.language && value.root) {
					value.language.deleteVirtualFile?.(value.root);
				}
				sourceFileRegistry.delete(normalizeId(id)); // deleted
				deleteVirtualFiles(value);
			}
		},
		getMirrorMap(file: VirtualFile) {
			if (!virtualFileToMirrorMap.has(file.snapshot)) {
				virtualFileToMirrorMap.set(file.snapshot, file.mirrorBehaviorMappings ? new MirrorMap(file.mirrorBehaviorMappings) : undefined);
			}
			return virtualFileToMirrorMap.get(file.snapshot);
		},
		getMaps(virtualFile: VirtualFile) {

			if (!virtualFileMaps.has(virtualFile.snapshot)) {
				virtualFileMaps.set(virtualFile.snapshot, new Map());
			}

			updateVirtualFileMaps(virtualFile, sourceId => {
				if (sourceId) {
					const sourceFile = sourceFileRegistry.get(normalizeId(sourceId))!;
					return [sourceId, sourceFile.snapshot];
				}
				else {
					const source = virtualFileRegistry.get(normalizeId(virtualFile.id))!.source;
					return [source.id, source.snapshot];
				}
			}, virtualFileMaps.get(virtualFile.snapshot));

			return virtualFileMaps.get(virtualFile.snapshot)!;
		},
		getSourceFile(id: string) {
			sync(id);
			return sourceFileRegistry.get(normalizeId(id));
		},
		getVirtualFile(id: string) {
			let sourceAndVirtual = virtualFileRegistry.get(normalizeId(id));
			if (sourceAndVirtual) {
				sync(sourceAndVirtual.source.id);
				sourceAndVirtual = virtualFileRegistry.get(normalizeId(id));
				if (sourceAndVirtual) {
					return [sourceAndVirtual.virtualFile, sourceAndVirtual.source] as const;
				}
			}
			return [undefined, undefined] as const;
		},
	};

	function deleteVirtualFiles(source: SourceFile) {
		if (source.root) {
			for (const file of forEachEmbeddedFile(source.root)) {
				virtualFileRegistry.delete(normalizeId(file.id));
			}
		}
	}

	function updateVirtualFiles(source: SourceFile) {
		if (source.root) {
			for (const file of forEachEmbeddedFile(source.root)) {
				virtualFileRegistry.set(normalizeId(file.id), { virtualFile: file, source });
			}
		}
	}
}

export function updateVirtualFileMaps(
	virtualFile: VirtualFile,
	getSourceSnapshot: (sourceUri: string | undefined) => [string, ts.IScriptSnapshot] | undefined,
	map: Map<string, [ts.IScriptSnapshot, SourceMap<FileRangeCapabilities>]> = new Map(),
) {

	const sources = new Set<string | undefined>();

	for (const mapping of virtualFile.mappings) {

		if (sources.has(mapping.source))
			continue;

		sources.add(mapping.source);

		const source = getSourceSnapshot(mapping.source);
		if (!source)
			continue;

		if (!map.has(source[0]) || map.get(source[0])![0] !== source[1]) {
			map.set(source[0], [source[1], new SourceMap(virtualFile.mappings.filter(mapping2 => mapping2.source === mapping.source))]);
		}
	}

	return map;
}

export function* forEachEmbeddedFile(file: VirtualFile): Generator<VirtualFile> {
	yield file;
	for (const embeddedFile of file.embeddedFiles) {
		for (const nextFile of forEachEmbeddedFile(embeddedFile)) {
			yield nextFile;
		}
	}
}
