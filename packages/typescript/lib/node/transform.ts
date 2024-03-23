import { Language, CodeInformation, shouldReportDiagnostics, SourceMap, SourceScript } from '@volar/language-core';
import type * as ts from 'typescript';
import { getServiceScript, notEmpty } from './utils';

const transformedDiagnostics = new WeakMap<ts.Diagnostic, ts.Diagnostic | undefined>();

export function transformCallHierarchyItem(files: Language, item: ts.CallHierarchyItem, filter: (data: CodeInformation) => boolean): ts.CallHierarchyItem {
	const span = transformSpan(files, item.file, item.span, filter);
	const selectionSpan = transformSpan(files, item.file, item.selectionSpan, filter);
	return {
		...item,
		span: span?.textSpan ?? { start: 0, length: 0 },
		selectionSpan: selectionSpan?.textSpan ?? { start: 0, length: 0 },
	};
}

export function transformDiagnostic<T extends ts.Diagnostic>(files: Language, diagnostic: T): T | undefined {
	if (!transformedDiagnostics.has(diagnostic)) {
		transformedDiagnostics.set(diagnostic, undefined);

		const { relatedInformation } = diagnostic;

		if (relatedInformation) {
			diagnostic.relatedInformation = relatedInformation
				.map(d => transformDiagnostic(files, d))
				.filter(notEmpty);
		}

		if (
			diagnostic.file !== undefined
			&& diagnostic.start !== undefined
			&& diagnostic.length !== undefined
		) {
			const [virtualCode, sourceScript, map] = getServiceScript(files, diagnostic.file.fileName);
			if (virtualCode) {
				const sourceRange = transformRange(sourceScript, map, diagnostic.start, diagnostic.start + diagnostic.length, shouldReportDiagnostics);
				if (sourceRange) {
					transformedDiagnostics.set(diagnostic, {
						...diagnostic,
						start: sourceRange[0],
						length: sourceRange[1] - sourceRange[0],
					});
				}
			}
			else {
				transformedDiagnostics.set(diagnostic, diagnostic);
			}
		}
		else {
			transformedDiagnostics.set(diagnostic, diagnostic);
		}
	}
	return transformedDiagnostics.get(diagnostic) as T | undefined;
}

export function transformFileTextChanges(files: Language, changes: ts.FileTextChanges, filter: (data: CodeInformation) => boolean): ts.FileTextChanges | undefined {
	const [_, source] = getServiceScript(files, changes.fileName);
	if (source) {
		return {
			...changes,
			textChanges: changes.textChanges.map(c => {
				const span = transformSpan(files, changes.fileName, c.span, filter);
				if (span) {
					return {
						...c,
						span: span.textSpan,
					};
				}
			}).filter(notEmpty),
		};
	}
	else {
		return changes;
	}
}

export function transformDocumentSpan<T extends ts.DocumentSpan>(files: Language, documentSpan: T, filter: (data: CodeInformation) => boolean, shouldFallback?: boolean): T | undefined {
	let textSpan = transformSpan(files, documentSpan.fileName, documentSpan.textSpan, filter);
	if (!textSpan && shouldFallback) {
		const [virtualCode] = getServiceScript(files, documentSpan.fileName);
		if (virtualCode) {
			textSpan = {
				fileName: documentSpan.fileName,
				textSpan: { start: 0, length: 0 },
			};
		}
	}
	if (!textSpan) {
		return;
	}
	const contextSpan = transformSpan(files, documentSpan.fileName, documentSpan.contextSpan, filter);
	const originalTextSpan = transformSpan(files, documentSpan.originalFileName, documentSpan.originalTextSpan, filter);
	const originalContextSpan = transformSpan(files, documentSpan.originalFileName, documentSpan.originalContextSpan, filter);
	return {
		...documentSpan,
		fileName: textSpan.fileName,
		textSpan: textSpan.textSpan,
		contextSpan: contextSpan?.textSpan,
		originalFileName: originalTextSpan?.fileName,
		originalTextSpan: originalTextSpan?.textSpan,
		originalContextSpan: originalContextSpan?.textSpan,
	};
}

export function transformSpan(files: Language, fileName: string | undefined, textSpan: ts.TextSpan | undefined, filter: (data: CodeInformation) => boolean): {
	fileName: string;
	textSpan: ts.TextSpan;
} | undefined {
	if (!fileName) {
		return;
	}
	if (!textSpan) {
		return;
	}
	const [virtualFile, sourceScript, map] = getServiceScript(files, fileName);
	if (virtualFile) {
		const sourceRange = transformRange(sourceScript, map, textSpan.start, textSpan.start + textSpan.length, filter);
		if (sourceRange) {
			return {
				fileName,
				textSpan: {
					start: sourceRange[0],
					length: sourceRange[1] - sourceRange[0],
				},
			};
		}
	}
	else {
		return {
			fileName,
			textSpan,
		};
	}
}

function transformRange(
	sourceScript: SourceScript,
	map: SourceMap<CodeInformation>,
	start: number,
	end: number,
	filter: (data: CodeInformation) => boolean,
) {
	for (const sourceStart of map.getSourceOffsets(start - sourceScript.snapshot.getLength())) {
		if (filter(sourceStart[1].data)) {
			for (const sourceEnd of map.getSourceOffsets(end - sourceScript.snapshot.getLength())) {
				if (sourceEnd[0] >= sourceStart[0] && filter(sourceEnd[1].data)) {
					return [sourceStart[0], sourceEnd[0]];
				}
			}
		}
	}
}
