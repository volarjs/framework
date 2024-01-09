import type { LabsInfo } from '@volar/vscode';
import * as vscode from 'vscode';

export async function useVolarExtensions(
	context: vscode.ExtensionContext,
	addExtension: (extension: vscode.Extension<LabsInfo>) => void
) {

	const checked = new Set<string>();

	let updateTimeout: NodeJS.Timeout | undefined;

	context.subscriptions.push(
		vscode.extensions.onDidChange(update),
		vscode.window.onDidChangeActiveTextEditor(update),
	);

	update();

	async function update() {
		if (updateTimeout) {
			clearTimeout(updateTimeout);
		};
		updateTimeout = setTimeout(() => {
			updateTimeout = undefined;
			vscode.extensions.all.forEach(extension => {
				if (!checked.has(extension.id) && extension.isActive) {
					checked.add(extension.id);
					if (extension.exports && 'volarLabs' in extension.exports) {
						addExtension(extension);
					}
				}
			});
		}, 1000);
	}
}

export function getIconPath(extension: vscode.Extension<any>) {
	if (extension.packageJSON?.icon) {
		return vscode.Uri.joinPath(extension.extensionUri, extension.packageJSON.icon);
	}
}
