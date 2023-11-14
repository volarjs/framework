import type { Config, Console, ServiceEnvironment } from '@volar/language-service';
import type { WorkspacesContext } from './project/basicProjectProvider';
import type { BasicServerPlugin } from '../lib/types';

export async function getConfig(context: WorkspacesContext, plugins: ReturnType<BasicServerPlugin>[], serviceEnv: ServiceEnvironment) {

	let config = (
		serviceEnv.workspaceFolder.uri.scheme === 'file' ? loadConfig(
			context.server.runtimeEnv.console,
			context.server.runtimeEnv.uriToFileName(serviceEnv.workspaceFolder.uri.toString()),
			context.workspaces.initOptions.configFilePath,
		) : {}
	) ?? {};

	for (const plugin of plugins) {
		if (plugin.resolveConfig) {
			config = await plugin.resolveConfig(config, serviceEnv);
		}
	}

	return config;
}

export function loadConfig(console: Console, dir: string, configFile: string | undefined): Config | undefined {
	let configPath: string | undefined;
	try {
		configPath = require.resolve(configFile ?? './volar.config.js', { paths: [dir] });
	} catch { }

	try {
		if (configPath) {
			const config: Config = require(configPath);
			delete require.cache[configPath];
			return config;
		}
	}
	catch (err) {
		console.warn(String(err));
	}
}
