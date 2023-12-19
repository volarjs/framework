import type { Console, FileSystem, LanguageService, ServiceEnvironment } from '@volar/language-service';
import type * as ts from 'typescript/lib/tsserverlibrary';
import type * as vscode from 'vscode-languageserver';

export interface Timer {
	setImmediate(callback: (...args: any[]) => void, ...args: any[]): vscode.Disposable;
	// Seems not useful
	// setTimeout(callback: (...args: any[]) => void, ms: number, ...args: any[]): vscode.Disposable;
}

export interface ServerRuntimeEnvironment {
	uriToFileName(uri: string): string;
	fileNameToUri(fileName: string): string;
	loadTypeScript(options: InitializationOptions): Promise<typeof import('typescript/lib/tsserverlibrary') | undefined>;
	loadTypeScriptLocalized(options: InitializationOptions, locale: string): Promise<{} | undefined>;
	fs: FileSystem;
	// https://github.com/microsoft/vscode/blob/7927075f89db213bc6e2182fa684d514d69e2359/extensions/html-language-features/server/src/htmlServer.ts#L53-L56
	timer: Timer;
	console: Console;
}

export interface ProjectContext {
	typescript?: {
		configFileName: string | undefined;
		parsedCommandLine: ts.ParsedCommandLine;
	};
}

export enum DiagnosticModel {
	None = 0,
	Push = 1,
	Pull = 2,
}

export interface InitializationOptions {
	typescript?: {
		/**
		 * Absolute path to node_modules/typescript/lib, available for node
		 */
		tsdk: string;
	} | {
		/**
		 * URI to node_modules/typescript/lib, available for web
		 * @example "https://cdn.jsdelivr.net/npm/typescript/lib"
		 * @example "https://cdn.jsdelivr.net/npm/typescript@latest/lib"
		 * @example "https://cdn.jsdelivr.net/npm/typescript@5.0.0/lib"
		 */
		tsdkUrl: string;
	};
	l10n?: {
		location: string; // uri
	};
	diagnosticModel?: DiagnosticModel;
	/**
	 * For better JSON parsing performance language server will filter CompletionList.
	 * 
	 * Enable this option if you want to get complete CompletionList in language client.
	 */
	fullCompletionList?: boolean;
	// for resolve https://github.com/sublimelsp/LSP-volar/issues/114
	ignoreTriggerCharacters?: string[];
	reverseConfigFilePriority?: boolean;
	maxFileSize?: number;
	/**
	 * Extra semantic token types and modifiers that are supported by the client.
	 */
	semanticTokensLegend?: vscode.SemanticTokensLegend;
	codegenStack?: boolean;
}

export interface ServerProject {
	serviceEnv: ServiceEnvironment;
	getLanguageService(): LanguageService;
	getLanguageServiceDontCreate(): LanguageService | undefined;
	dispose(): void;
}

export interface ServerProjectProvider {
	getProject(uri: string): Promise<ServerProject>;
	getProjects(): Promise<ServerProject[]>;
	reloadProjects(): Promise<void> | void;
}
