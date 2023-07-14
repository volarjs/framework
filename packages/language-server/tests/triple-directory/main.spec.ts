import { describe, it } from 'vitest';
import { URI } from 'vscode-uri';
import { createSys } from '../../../typescript';
import { createFs, fileNameToUri, uriToFileName } from '../../src/node';

describe('triple-directory', () => {

	// https://github.com/vuejs/language-tools/issues/3282
	it('Should not throw "Maximum call stack size exceeded"', () => {
		const sys = createSys(require('typescript'), {
			workspaceUri: URI.parse(fileNameToUri(__dirname)),
			rootUri: URI.parse(fileNameToUri(__dirname)),
			fileNameToUri,
			uriToFileName,
			fs: createFs({}),
			console,
		});
		sys.readDirectory(__dirname);
	});
});
