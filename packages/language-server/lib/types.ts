import type { LanguageService } from '@volar/language-service';
import type * as vscode from 'vscode-languageserver';
import type { URI } from 'vscode-uri';
import type { createServerBase } from './server';

export interface InitializationOptions {
	maxFileSize?: number;
}

export type VolarInitializeParams = Omit<vscode.InitializeParams, 'initializationOptions'> & { initializationOptions?: InitializationOptions; };;

export interface ServerProject {
	getLanguageService(): LanguageService;
	getLanguageServiceDontCreate(): LanguageService | undefined;
	dispose(): void;
}

export interface ServerProjectProvider {
	get(this: ServerBase, uri: URI): Promise<ServerProject>;
	all(this: ServerBase): Promise<ServerProject[]>;
	reload(this: ServerBase): void;
}

export type ServerBase = ReturnType<typeof createServerBase>;
