import * as vscode from 'vscode-languageserver';

export function register(
	connection: vscode.Connection,
	initializeParams: vscode.InitializeParams
) {
	const configurations = new Map<string, Promise<any>>();
	const didChangeCallbacks = new Set<vscode.NotificationHandler<vscode.DidChangeConfigurationParams>>();

	let registered = false;

	connection.onDidChangeConfiguration(params => {
		configurations.clear(); // TODO: clear only the configurations that changed
		for (const cb of didChangeCallbacks) {
			cb(params);
		}
	});

	return {
		get,
		onDidChange,
	};

	function get<T>(section: string, scopeUri?: string): Promise<T | undefined> {
		if (!initializeParams.capabilities.workspace?.configuration) {
			return Promise.resolve(undefined);
		}
		const didChangeConfiguration = initializeParams.capabilities.workspace?.didChangeConfiguration;
		if (!scopeUri && didChangeConfiguration) {
			if (!configurations.has(section)) {
				configurations.set(section, getConfigurationWorker(section, scopeUri));
			}
			if (!registered && didChangeConfiguration.dynamicRegistration) {
				connection.client.register(vscode.DidChangeConfigurationNotification.type);
			}
			return configurations.get(section)!;
		}
		return getConfigurationWorker(section, scopeUri);
	}

	function onDidChange(cb: vscode.NotificationHandler<vscode.DidChangeConfigurationParams>) {
		didChangeCallbacks.add(cb);
		return {
			dispose() {
				didChangeCallbacks.delete(cb);
			},
		};
	}

	async function getConfigurationWorker(section: string, scopeUri?: string) {
		return (await connection.workspace.getConfiguration({ scopeUri, section })) ?? undefined /* replace null to undefined */;
	}
}
