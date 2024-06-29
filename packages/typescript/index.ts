export * from './lib/common';
export * from './lib/node/proxyLanguageService';
export * from './lib/node/decorateLanguageServiceHost';
export * from './lib/node/decorateProgram';
export * from './lib/node/proxyCreateProgram';
export * from './lib/protocol/createProject';
export * from './lib/protocol/createSys';

import type { VirtualCode } from '@volar/language-core';
import type * as ts from 'typescript';
import { URI } from 'vscode-uri';

declare module '@volar/language-service' {
	export interface ProjectContext {
		typescript?: {
			configFileName: string | undefined;
			sys: ts.System & {
				version?: number;
				sync?(): Promise<number>;
			};
			languageServiceHost: ts.LanguageServiceHost;
			getExtraServiceScript(fileName: string): TypeScriptExtraServiceScript | undefined;
			asUri(fileName: string): URI;
			asFileName(uri: URI): string;
		};
	}
}

declare module '@volar/language-core' {
	export interface LanguagePlugin<T = unknown, K extends VirtualCode = VirtualCode> {
		typescript?: TypeScriptGenericOptions<K> & TypeScriptNonTSPluginOptions<K>;
	}
}

/**
 * The following options available to all situations.
 */
interface TypeScriptGenericOptions<K> {
	extraFileExtensions: ts.FileExtensionInfo[];
	resolveHiddenExtensions?: boolean;
	getServiceScript(root: K): TypeScriptServiceScript | undefined;
}

/**
 * The following options will not be available in TS plugin.
 */
interface TypeScriptNonTSPluginOptions<K> {
	getExtraServiceScripts?(fileName: string, rootVirtualCode: K): TypeScriptExtraServiceScript[];
	resolveLanguageServiceHost?(host: ts.LanguageServiceHost): ts.LanguageServiceHost;
}

export interface TypeScriptServiceScript {
	code: VirtualCode;
	extension: '.ts' | '.js' | '.mts' | '.mjs' | '.cjs' | '.cts' | '.d.ts' | string;
	scriptKind: ts.ScriptKind;
	/** See #188 */
	preventLeadingOffset?: boolean;
}

export interface TypeScriptExtraServiceScript extends TypeScriptServiceScript {
	fileName: string;
}
