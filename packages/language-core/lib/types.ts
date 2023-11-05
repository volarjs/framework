import { Mapping, Stack } from '@volar/source-map';
import type * as ts from 'typescript/lib/tsserverlibrary';

export interface FileCapabilities {
	diagnostic?: boolean;
	foldingRange?: boolean;
	documentFormatting?: boolean;
	documentSymbol?: boolean;
	codeAction?: boolean;
	inlayHint?: boolean;
}

export interface FileRangeCapabilities {
	hover?: boolean;
	references?: boolean;
	definition?: boolean;
	rename?: boolean | {
		normalize?(newName: string): string;
		apply?(newName: string): string;
	};
	completion?: boolean | {
		additional?: boolean;
		autoImportOnly?: boolean;
	};
	diagnostic?: boolean | {
		shouldReport(): boolean;
	};
	semanticTokens?: boolean;

	// TODO
	referencesCodeLens?: boolean;
	displayWithLink?: boolean;
}

export interface MirrorBehaviorCapabilities {
	references?: boolean;
	definition?: boolean;
	rename?: boolean;
}

export namespace FileCapabilities {
	export const full: FileCapabilities = {
		diagnostic: true,
		foldingRange: true,
		documentFormatting: true,
		documentSymbol: true,
		codeAction: true,
		inlayHint: true,
	};
}

export namespace FileRangeCapabilities {
	export const full: FileRangeCapabilities = {
		hover: true,
		references: true,
		definition: true,
		rename: true,
		completion: true,
		diagnostic: true,
		semanticTokens: true,
	};
}

export namespace MirrorBehaviorCapabilities {
	export const full: MirrorBehaviorCapabilities = {
		references: true,
		definition: true,
		rename: true,
	};
}

export enum FileKind {
	TextFile = 0,
	TypeScriptHostFile = 1,
}

export interface VirtualFile {
	fileName: string,
	snapshot: ts.IScriptSnapshot,
	kind: FileKind,
	capabilities: FileCapabilities,
	mappings: Mapping<FileRangeCapabilities>[],
	codegenStacks: Stack[],
	mirrorBehaviorMappings?: Mapping<[MirrorBehaviorCapabilities, MirrorBehaviorCapabilities]>[],
	embeddedFiles: VirtualFile[],
}

export interface Language<T extends VirtualFile = VirtualFile, P extends ProjectHost = ProjectHost> {
	resolveHost?(host: P): P;
	createVirtualFile(fileName: string, snapshot: ts.IScriptSnapshot, languageId: string | undefined): T | undefined;
	updateVirtualFile(virtualFile: T, snapshot: ts.IScriptSnapshot): void;
	deleteVirtualFile?(virtualFile: T): void;
}

export interface ProjectHost {
	workspacePath: string;
	rootPath: string;
	getProjectVersion(): string;
	getScriptFileNames(): string[];
	getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined;
	getLanguageId?(fileName: string): string | undefined;
	getCancellationToken?(): ts.HostCancellationToken;
}

export interface TypeScriptProjectHost extends ProjectHost, Pick<
	ts.LanguageServiceHost,
	'getLocalizedDiagnosticMessages'
	| 'getCompilationSettings'
	| 'getProjectReferences'
> {
	resolveModuleName?(path: string, impliedNodeFormat?: ts.ResolutionMode): string;
}
