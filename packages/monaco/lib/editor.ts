import { fromPosition, toMarkerData, toTextEdit } from 'monaco-languageserver-types';
import type { CancellationToken, editor, IDisposable, MonacoEditor, Uri } from 'monaco-types';
import { WorkerLanguageService } from '../worker.js';
import { markers } from './markers.js';
import { getRequestId } from './requestId.js';

interface IInternalEditorModel extends editor.IModel {
	onDidChangeAttached(listener: () => void): IDisposable;
	isAttachedToEditor(): boolean;
}

export function activateMarkers(
	worker: editor.MonacoWebWorker<WorkerLanguageService>,
	languages: string[],
	markersOwn: string,
	getSyncUris: () => Uri[],
	editor: MonacoEditor['editor']
): IDisposable {

	const disposables: IDisposable[] = [];
	const listener = new Map<string, IDisposable>();

	disposables.push(
		editor.onDidCreateModel(model => hostingMarkers(model)),
		editor.onWillDisposeModel(stopHostingMarkers),
		editor.onDidChangeModelLanguage(event => {
			stopHostingMarkers(event.model);
			hostingMarkers(event.model);
		}),
		{
			dispose: () => {
				for (const model of editor.getModels()) {
					stopHostingMarkers(model);
				}
			}
		}
	);

	for (const model of editor.getModels()) {
		hostingMarkers(model);
	}

	return { dispose: () => disposables.forEach(d => d.dispose()) };

	function stopHostingMarkers(model: editor.IModel): void {
		editor.setModelMarkers(model, markersOwn, []);
		const key = model.uri.toString();
		if (listener.has(key)) {
			listener.get(key)?.dispose();
			listener.delete(key);
		}
	}

	function hostingMarkers(model: IInternalEditorModel): void {
		if (!languages.includes(model.getLanguageId?.() ?? (model as any).getModeId?.())) {
			return;
		}

		let timer: ReturnType<typeof setTimeout> | undefined;
		const changeSubscription = model.onDidChangeContent(() => {
			clearTimeout(timer);
			timer = setTimeout(() => doValidation(model), 250);
		});
		const visibleSubscription = model.onDidChangeAttached(() => {
			if (model.isAttachedToEditor()) {
				doValidation(model);
			} else {
				editor.setModelMarkers(model, markersOwn, []);
			}
		});

		listener.set(
			model.uri.toString(),
			{
				dispose: () => {
					changeSubscription.dispose();
					visibleSubscription.dispose();
					clearTimeout(timer);
				}
			}
		);

		doValidation(model);
	}

	async function doValidation(model: editor.ITextModel) {
		if (model.isDisposed()) {
			return;
		}
		if (!model.isAttachedToEditor()) {
			return;
		}

		const languageService = await worker.withSyncedResources(getSyncUris());
		const token = createTokenForModelChange(model);
		const diagnostics = await languageService.getDiagnostics(
			getRequestId(token.token, languageService),
			model.uri
		);
		token.dispose();
		if (token.token.isCancellationRequested) {
			return;
		}
		const result = diagnostics.map(error => {
			const marker = toMarkerData(error);
			markers.set(marker, error);
			return marker;
		});

		editor.setModelMarkers(model, markersOwn, result);
	}
}

export function activateAutoInsertion(
	worker: editor.MonacoWebWorker<WorkerLanguageService>,
	languages: string[],
	getSyncUris: () => Uri[],
	editor: MonacoEditor['editor']
): IDisposable {

	const disposables: IDisposable[] = [];
	const listener = new Map<editor.IModel, IDisposable>();

	let timeout: ReturnType<typeof setTimeout> | undefined;

	disposables.push(
		editor.onDidCreateModel(model => hostingAutoInsertion(model)),
		editor.onWillDisposeModel(stopHostingAutoInsertion),
		editor.onDidChangeModelLanguage(event => {
			stopHostingAutoInsertion(event.model);
			hostingAutoInsertion(event.model);
		}),
		{
			dispose: () => {
				for (const disposable of listener.values()) {
					disposable.dispose();
				}
				listener.clear();
			}
		}
	);

	for (const model of editor.getModels()) {
		hostingAutoInsertion(model);
	}

	return { dispose: () => disposables.forEach(d => d.dispose()) };

	function stopHostingAutoInsertion(model: editor.IModel): void {
		if (listener.has(model)) {
			listener.get(model)?.dispose();
			listener.delete(model);
		}
	}

	function hostingAutoInsertion(model: IInternalEditorModel) {
		if (!languages.includes(model.getLanguageId?.() ?? (model as any).getModeId?.())) {
			return;
		}
		listener.set(model, model.onDidChangeContent(e => {
			if (model.isDisposed()) {
				return;
			}
			if (!model.isAttachedToEditor()) {
				return;
			}
			if (e.changes.length === 0 || e.isUndoing || e.isRedoing) {
				return;
			}
			const lastChange = e.changes[e.changes.length - 1];
			doAutoInsert(model, lastChange);
		}));
	}

	async function doAutoInsert(
		model: editor.ITextModel,
		lastChange: editor.IModelContentChange
	) {
		if (timeout) {
			clearTimeout(timeout);
			timeout = undefined;
		}
		const version = model.getVersionId();
		timeout = setTimeout(() => {
			(async () => {
				if (model.getVersionId() !== version) {
					return;
				}
				const languageService = await worker.withSyncedResources(getSyncUris());
				const token = createTokenForModelChange(model);
				const edit = await languageService.getAutoInsertSnippet(
					getRequestId(token.token, languageService),
					model.uri,
					fromPosition({
						lineNumber: lastChange.range.startLineNumber,
						column: lastChange.range.startColumn + lastChange.text.length,
					}),
					{
						text: lastChange.text,
						rangeOffset: lastChange.rangeOffset,
						rangeLength: lastChange.rangeLength,
					}
				);
				token.dispose();
				if (token.token.isCancellationRequested) {
					return;
				}
				const codeEditor = editor.getEditors().find(e => e.getModel() === model);
				if (codeEditor && edit && model.getVersionId() === version) {
					if (typeof edit === 'string') {
						codeEditor?.getContribution('snippetController2')
							// @ts-expect-error
							?.insert(edit);
					}
					else {
						model.pushEditOperations([], [toTextEdit(edit)], () => []);
					}
				}
			})();
			timeout = undefined;
		}, 100);
	}
}

function createTokenForModelChange(model: editor.ITextModel) {
	const lastVersionId = model.getVersionId();
	let callbacks: Set<IDisposable> | undefined;
	const token: CancellationToken = {
		get isCancellationRequested() {
			return model.getVersionId() !== lastVersionId;
		},
		onCancellationRequested(cb) {
			const disposable = model.onDidChangeContent(() => {
				cb(undefined);
				disposable.dispose();
				callbacks?.delete(disposable);
			});
			callbacks ??= new Set();
			callbacks.add(disposable);
			return {
				dispose() {
					disposable.dispose();
					callbacks?.delete(disposable);
				},
			};
		},
	};
	return {
		token,
		dispose() {
			if (callbacks) {
				for (const disposable of callbacks) {
					disposable.dispose();
				}
				callbacks.clear();
			}
		},
	};
}
