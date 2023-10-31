import * as vscode from 'vscode-languageserver/browser';
import { startCommonLanguageServer } from '../common/server';
import { LanguageServerPlugin } from '../types';
import httpSchemaRequestHandler from '../common/schemaRequestHandlers/http';
import { URI } from 'vscode-uri';
import { FsReadFileRequest, FsReadDirectoryRequest } from '../protocol';
import { FileSystem, FileType } from '@volar/language-service';

export * from '../index';

export function createConnection() {

	const messageReader = new vscode.BrowserMessageReader(self);
	const messageWriter = new vscode.BrowserMessageWriter(self);
	const connection = vscode.createConnection(messageReader, messageWriter);

	return connection;
}

export function startLanguageServer(connection: vscode.Connection, ...plugins: LanguageServerPlugin[]) {
	startCommonLanguageServer(connection, plugins, () => ({
		uriToFileName,
		fileNameToUri,
		console: connection.console,
		timer: {
			setImmediate(callback: (...args: any[]) => void, ...args: any[]): vscode.Disposable {
				const handle = setTimeout(callback, 0, ...args);
				return { dispose: () => clearTimeout(handle) };
			},
		},
		async loadTypeScript(options) {
			const tsdkUri = options.typescript && 'tsdkUrl' in options.typescript
				? options.typescript.tsdkUrl
				: undefined;
			if (!tsdkUri) {
				return;
			}
			const _module = globalThis.module;
			globalThis.module = { exports: {} } as typeof _module;
			await import(`${tsdkUri}/lib/typescript.js`);
			const ts = globalThis.module.exports;
			globalThis.module = _module;
			return ts as typeof import('typescript/lib/tsserverlibrary');
		},
		async loadTypeScriptLocalized(options, locale) {
			const tsdkUri = options.typescript && 'tsdkUrl' in options.typescript
				? options.typescript.tsdkUrl
				: undefined;
			if (!tsdkUri) {
				return;
			}
			try {
				const uri = fileNameToUri(`${tsdkUri}/${locale}/diagnosticMessages.generated.json`);
				const json = await httpSchemaRequestHandler(uri);
				if (json) {
					return JSON.parse(json);
				}
			}
			catch { }
		},
		fs: createFs(connection),
		getCancellationToken(original) {
			return original ?? vscode.CancellationToken.None;
		},
	}));
}

/**
 * To avoid hitting the API hourly limit, we keep requests as low as possible.
 */
function createFs(connection: vscode.Connection): FileSystem {

	const readDirectoryResults = new Map<string, Promise<[string, FileType][]>>();

	return {
		async stat(uri) {
			if (uri.startsWith('__invalid__:')) {
				return;
			}
			if (uri.startsWith('http://') || uri.startsWith('https://')) {
				const text = await this.readFile(uri); // TODO: perf
				if (text !== undefined) {
					return {
						type: FileType.File,
						size: text.length,
						ctime: -1,
						mtime: -1,
					};
				}
				return undefined;
			}
			const dirUri = uri.substring(0, uri.lastIndexOf('/'));
			const baseName = uri.substring(uri.lastIndexOf('/') + 1);
			const entries = await this.readDirectory(dirUri);
			const matches = entries.filter(entry => entry[0] === baseName);
			if (matches.length) {
				return {
					type: matches.some(entry => entry[1] === FileType.File) ? FileType.File : matches[0][1],
					size: -1,
					ctime: -1,
					mtime: -1,
				};
			}
		},
		async readFile(uri) {
			if (uri.startsWith('__invalid__:')) {
				return;
			}
			if (uri.startsWith('http://') || uri.startsWith('https://')) {
				return await httpSchemaRequestHandler(uri);
			}
			const dirUri = uri.substring(0, uri.lastIndexOf('/'));
			const baseName = uri.substring(uri.lastIndexOf('/') + 1);
			const entries = await this.readDirectory(dirUri);
			const file = entries.filter(entry => entry[0] === baseName && entry[1] === FileType.File);
			if (file) {
				const text = await connection.sendRequest(FsReadFileRequest.type, uri);
				if (text !== undefined && text !== null) {
					return text;
				}
			}
		},
		async readDirectory(uri) {
			if (uri.startsWith('__invalid__:')) {
				return [];
			}
			if (uri.startsWith('http://') || uri.startsWith('https://')) {
				return [];
			}
			if (!readDirectoryResults.has(uri)) {
				readDirectoryResults.set(uri, connection.sendRequest(FsReadDirectoryRequest.type, uri));
			}
			return await readDirectoryResults.get(uri)!;
		},
	};
}

function uriToFileName(uri: string) {
	const parsed = URI.parse(uri);
	if (parsed.scheme === '__invalid__') {
		return parsed.path;
	}
	return `/${parsed.scheme}${parsed.authority ? '@' + parsed.authority : ''}${parsed.path}`;
}

function fileNameToUri(fileName: string) {
	const parts = fileName.split('/');
	if (parts.length <= 1) {
		return URI.from({
			scheme: '__invalid__',
			path: fileName,
		}).toString();
	}
	const firstParts = parts[1].split('@');
	return URI.from({
		scheme: firstParts[0],
		authority: firstParts.length > 1 ? firstParts[1] : undefined,
		path: '/' + parts.slice(2).join('/'),
	}).toString();
}
