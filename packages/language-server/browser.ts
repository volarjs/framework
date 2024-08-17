import * as vscode from 'vscode-languageserver/browser';
import { URI } from 'vscode-uri';
import { handler as httpSchemaRequestHandler } from './lib/fileSystemProviders/http';
import { createServerBase } from './lib/server';
import { provider as httpFsProvider } from './lib/fileSystemProviders/http';

export * from 'vscode-languageserver/browser';
export * from './index';
export * from './lib/project/simpleProject';
export * from './lib/project/typescriptProject';
export * from './lib/server';

export function createConnection() {
	const messageReader = new vscode.BrowserMessageReader(self);
	const messageWriter = new vscode.BrowserMessageWriter(self);
	const connection = vscode.createConnection(messageReader, messageWriter);

	return connection;
}

export function createServer(connection: vscode.Connection) {
	const server = createServerBase(connection);
	// TODO
	// {
	// 	async stat(uri) {
	// 		return await connection.sendRequest(FsStatRequest.type, uri.toString());
	// 	},
	// 	async readFile(uri) {
	// 		return await connection.sendRequest(FsReadFileRequest.type, uri.toString()) ?? undefined;
	// 	},
	// 	async readDirectory(uri) {
	// 		return await connection.sendRequest(FsReadDirectoryRequest.type, uri.toString());
	// 	},
	// }
	server.features.fileSystem.install('http', httpFsProvider);
	server.features.fileSystem.install('https', httpFsProvider);
	return server;
}

export async function loadTsdkByUrl(tsdkUrl: string, locale: string | undefined) {
	locale = locale?.toLowerCase();

	return {
		typescript: await loadLib(),
		diagnosticMessages: await loadLocalizedDiagnosticMessages(),
	};

	async function loadLib(): Promise<typeof import('typescript')> {
		const originalModule = globalThis.module;
		try {
			globalThis.module = { exports: {} } as typeof originalModule;
			await import(`${tsdkUrl}/typescript.js`);
			return globalThis.module.exports as typeof import('typescript');
		} finally {
			globalThis.module = originalModule;
		}
	}

	async function loadLocalizedDiagnosticMessages(): Promise<import('typescript').MapLike<string> | undefined> {
		if (locale === 'en') {
			return;
		}
		try {
			const json = await httpSchemaRequestHandler(URI.parse(`${tsdkUrl}/${locale}/diagnosticMessages.generated.json`));
			if (json) {
				return JSON.parse(json);
			}
		}
		catch { }
	}
}
