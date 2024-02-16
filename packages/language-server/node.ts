import { FileSystem, FileType } from '@volar/language-service';
import * as fs from 'fs';
import * as vscode from 'vscode-languageserver/node';
import httpSchemaRequestHandler from './lib/schemaRequestHandlers/http';
import { createServerBase } from './lib/server';
import type { InitializationOptions } from './lib/types';
import { fileNameToUri, uriToFileName } from './lib/uri';

export * from 'vscode-languageserver/node';
export * from './index';
export * from './lib/project/simpleProjectProvider';
export * from './lib/project/typescriptProjectProvider';

export function createFs(options: InitializationOptions): FileSystem {
	return {
		stat(uri) {
			if (uri.startsWith('file://')) {
				try {
					const stats = fs.statSync(uriToFileName(uri), { throwIfNoEntry: false });
					if (stats) {
						return {
							type: stats.isFile() ? FileType.File
								: stats.isDirectory() ? FileType.Directory
									: stats.isSymbolicLink() ? FileType.SymbolicLink
										: FileType.Unknown,
							ctime: stats.ctimeMs,
							mtime: stats.mtimeMs,
							size: stats.size,
						};
					}
				}
				catch {
					return undefined;
				}
			}
		},
		readFile(uri, encoding) {
			if (uri.startsWith('file://')) {
				try {
					if (options.maxFileSize) {
						const stats = fs.statSync(uriToFileName(uri), { throwIfNoEntry: false });
						if (stats && stats.size > options.maxFileSize) {
							console.warn(`[volar] file size exceeded limit: ${uri} (${stats.size} > ${options.maxFileSize})`);
							return undefined;
						}
					}
					return fs.readFileSync(uriToFileName(uri), { encoding: encoding as 'utf-8' ?? 'utf-8' });
				}
				catch {
					return undefined;
				}
			}
			if (uri.startsWith('http://') || uri.startsWith('https://')) {
				return httpSchemaRequestHandler(uri);
			}
		},
		readDirectory(uri) {
			if (uri.startsWith('file://')) {
				try {
					const dirName = uriToFileName(uri);
					const files = fs.readdirSync(dirName, { withFileTypes: true });
					return files.map<[string, FileType]>(file => {
						return [file.name, file.isFile() ? FileType.File
							: file.isDirectory() ? FileType.Directory
								: file.isSymbolicLink() ? FileType.SymbolicLink
									: FileType.Unknown];
					});
				}
				catch {
					return [];
				}
			}
			return [];
		},
	};
}

export function createConnection() {
	return vscode.createConnection(vscode.ProposedFeatures.all);
}

export function createServer(connection: vscode.Connection) {
	return createServerBase(connection, params => ({
		uriToFileName,
		fileNameToUri,
		console: connection.console,
		timer: {
			setImmediate(callback: (...args: any[]) => void, ...args: any[]): vscode.Disposable {
				const handle = setImmediate(callback, ...args);
				return { dispose: () => clearImmediate(handle) };
			},
		},
		loadTypeScript(options) {
			const tsdk = options.typescript && 'tsdk' in options.typescript
				? options.typescript.tsdk
				: undefined;
			if (!tsdk) {
				return;
			}
			for (const name of ['./typescript.js', './tsserverlibrary.js']) {
				try {
					return require(require.resolve(name, { paths: [tsdk] }));
				} catch { }
			}

			// for bun
			for (const name of ['typescript.js', 'tsserverlibrary.js']) {
				try {
					return require(tsdk + '/' + name);
				} catch { }
			}

			throw new Error(`Can't find typescript.js or tsserverlibrary.js in ${tsdk}`);
		},
		async loadTypeScriptLocalized(options, locale) {
			const tsdk = options.typescript && 'tsdk' in options.typescript
				? options.typescript.tsdk
				: undefined;
			if (!tsdk) {
				return;
			}
			try {
				const path = require.resolve(`./${locale}/diagnosticMessages.generated.json`, { paths: [tsdk] });
				return require(path);
			} catch { }
		},
		fs: createFs(params.initializationOptions ?? {}),
	}));
}
