import * as vscode from 'vscode-languageserver-protocol';
import type { ServiceContext } from '../types';
import { InlayHintData } from './inlayHints';

export function register(context: ServiceContext) {

	return async (item: vscode.InlayHint, token = vscode.CancellationToken.None) => {

		const data: InlayHintData | undefined = item.data;
		if (data) {
			const plugin = context.plugins[data.pluginId];
			if (!plugin.resolveInlayHint)
				return item;

			Object.assign(item, data.original);
			item = await plugin.resolveInlayHint(item, token);
		}

		return item;
	};
}
