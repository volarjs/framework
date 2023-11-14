import * as vscode from 'vscode';
import type { BaseLanguageClient } from 'vscode-languageclient';
import { GetMatchTsConfigRequest } from '@volar/language-server/protocol';
import * as path from 'path-browserify';

export function activate(
	cmd: string,
	client: BaseLanguageClient,
	shouldStatusBarShow: (document: vscode.TextDocument) => boolean,
) {

	const subscriptions: vscode.Disposable[] = [];
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
	let currentTsconfigUri: vscode.Uri | undefined;

	updateStatusBar();

	vscode.window.onDidChangeActiveTextEditor(updateStatusBar, undefined, subscriptions);

	subscriptions.push(vscode.commands.registerCommand(cmd, async () => {
		if (currentTsconfigUri) {
			const document = await vscode.workspace.openTextDocument(currentTsconfigUri);
			await vscode.window.showTextDocument(document);
		}
	}));

	subscriptions.push(...subscriptions);

	async function updateStatusBar() {
		if (
			!vscode.window.activeTextEditor
			|| !shouldStatusBarShow(vscode.window.activeTextEditor.document)
		) {
			statusBar.hide();
		}
		else {
			const tsconfig = await client.sendRequest(
				GetMatchTsConfigRequest.type,
				client.code2ProtocolConverter.asTextDocumentIdentifier(vscode.window.activeTextEditor.document),
			);
			if (tsconfig?.uri) {
				currentTsconfigUri = vscode.Uri.parse(tsconfig.uri);
				statusBar.text = path.relative(
					(vscode.workspace.rootPath?.replace(/\\/g, '/') || '/'),
					currentTsconfigUri.fsPath.replace(/\\/g, '/'),
				);
				statusBar.command = cmd;
			}
			else {
				statusBar.text = 'No tsconfig';
				statusBar.command = undefined;
			}
			statusBar.show();
		}
	}
}
