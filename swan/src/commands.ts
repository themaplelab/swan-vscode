import * as vscode from 'vscode';
import * as tree from './tree';
const exec = require('child_process').exec;
const io = require('socket.io')();

const port = 4040;

let GlobalSocket : any = undefined;

// TODO: Make sure the frontend context is enforced
// Related: https://github.com/Microsoft/vscode/issues/10471

export function activate(context: vscode.ExtensionContext) {

	let pathProvider = new tree.TaintAnalysisPathProvider();

	vscode.commands.executeCommand('setContext', 'SWANStarted', false);
	vscode.commands.executeCommand('setContext', 'dataFlowGenerated', false);

	let runTaintAnalysis = vscode.commands.registerCommand('commands.runTaintAnalysis', () => {
		io.to(GlobalSocket).emit("runTaintAnalysis");
	});

	let taintAnalysisResults = vscode.commands.registerCommand('commands.taintAnalysisResults', () => {
		vscode.window.createTreeView(
			'taintAnalysisSideBar',
			{
				treeDataProvider: pathProvider
			}
		);
	});

	let startSWAN = vscode.commands.registerCommand('commands.startSWAN', () => {
		try {
			if (process.env.PATH_TO_SWAN === undefined) {
				vscode.window.showErrorMessage(
					"Environment variable PATH_TO_SWAN not set!", 'Learn More')
					.then(_ => {
						vscode.env.openExternal(vscode.Uri.parse('https://github.com/themaplelab/swan'));
					});
				return;
			}

			io.on('connection', (socket : any) => { 
				GlobalSocket = socket.id;
				vscode.window.showInformationMessage("Started SWAN JVM");
				vscode.commands.executeCommand('setContext', 'SWANStarted', true);

				socket.on('taintAnalysisResults', (json : any) => {
					pathProvider.setPaths(json);
					vscode.commands.executeCommand('commands.taintAnalysisResults');
				});
				
				socket.on('disconnect', (data : any) => {
					io.off();
				});

				socket.on('error', (e : any) => {
					vscode.window.showErrorMessage("JVM error: " + e);
				});
			});
			io.listen(4040);

			const command = "/." + process.env.PATH_TO_SWAN + "/gradlew run -p" + process.env.PATH_TO_SWAN;
			let script = exec(command, {encoding : 'utf-8'},  
				(error : any, stdout : any , stderr : any) => {
					if (error !== null) {
						vscode.window.showErrorMessage("Something went wrong with the JVM: " + stderr);
					} else {
						vscode.window.showInformationMessage("Stopped SWAN JVM");
						vscode.commands.executeCommand('setContext', 'SWANStarted', false);
					}
			});
		
		} catch (e) {
			vscode.window.showWarningMessage("Could not start SWAN: " + e);
			vscode.commands.executeCommand('setContext', 'SWANStarted', false);
		}
	});

	let stopSWAN = vscode.commands.registerCommand('commands.stopSWAN', () => {
		try {
			io.to(GlobalSocket).emit("disconnect");
		} catch (e) {
			vscode.window.showErrorMessage("Could not stop SWAN JVM: " + e);
		}
	});

	let generateDataFlow = vscode.commands.registerCommand('commands.generateDataFlow', () => {
		// Call SWAN operation based off settings.json.
		
		// If successful, call this.
		vscode.commands.executeCommand('setContext', 'dataFlowGenerated', true);
	});

	let openFileCommand = vscode.commands.registerCommand('openFile', (filename : string) => {
		vscode.workspace.openTextDocument(filename).then(doc => {
			vscode.window.showTextDocument(doc);
		});
	});
		
	context.subscriptions.push(openFileCommand);
	context.subscriptions.push(runTaintAnalysis);
	context.subscriptions.push(taintAnalysisResults);
	context.subscriptions.push(startSWAN);
	context.subscriptions.push(stopSWAN);
	context.subscriptions.push(generateDataFlow);
}

export function deactivate() {
	if (GlobalSocket !== undefined) {
		try {
			io.to(GlobalSocket).emit("disconnect");
		} catch (e) {
			vscode.window.showErrorMessage("Could not stop SWAN JVM: " + e);
		}
	}
}

export class OpenFileCommand implements vscode.Command {
	title: string = 'Open File';	command: string = 'openFile';
	tooltip?: string | undefined;
	arguments?: any[] | undefined;

	constructor(filename : string) {
		this.arguments = [filename];
	}
}