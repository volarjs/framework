import type { ServiceContext } from '../types';
import { embeddedEditToSourceEdit } from './rename';
import type * as _ from 'vscode-languageserver-protocol';
import * as dedupe from '../utils/dedupe';
import { FileKind, forEachEmbeddedFile } from '@volar/language-core';
import { NoneCancellationToken } from '../utils/cancellation';

export function register(context: ServiceContext) {

	return async (oldUri: string, newUri: string, token = NoneCancellationToken) => {

		const sourceFile = context.project.fileProvider.getSourceFile(oldUri);
		const rootFile = sourceFile?.root;

		if (sourceFile && rootFile) {

			let tsExt: string | undefined;

			forEachEmbeddedFile(rootFile, virtualFile => {
				if (virtualFile.kind === FileKind.TypeScriptHostFile && virtualFile.id.replace(sourceFile.id, '').match(/^\.(js|ts)x?$/)) {
					tsExt = virtualFile.id.substring(virtualFile.id.lastIndexOf('.'));
				}
			});

			if (!tsExt) {
				return;
			}

			oldUri += tsExt;
			newUri += tsExt;
		}

		for (const service of context.services) {

			if (token.isCancellationRequested)
				break;

			if (!service.provideFileRenameEdits)
				continue;

			const workspaceEdit = await service.provideFileRenameEdits(oldUri, newUri, token);

			if (workspaceEdit) {

				const result = embeddedEditToSourceEdit(
					workspaceEdit,
					context,
					'fileName',
				);

				if (result?.documentChanges) {
					result.documentChanges = dedupe.withDocumentChanges(result.documentChanges);
				}

				return result;
			}
		}
	};
}
