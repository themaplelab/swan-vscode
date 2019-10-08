import * as vscode from 'vscode';
import * as tree from './tree';
const exec = require('child_process').exec;
const execSync = require('child_process').execSync;
const io = require('socket.io')();
const fs = require('fs');

const port = 4040;

let GLOBAL_SOCKET : any = undefined;
let SWAN_STARTED = false;
let PROJECT_COMPILED = false;
let COMPILING = false;

let timer : NodeJS.Timeout;

export function activate(context: vscode.ExtensionContext) {

	let pathProvider = new tree.TaintAnalysisPathProvider();

	let runTaintAnalysis = vscode.commands.registerCommand('swan.runTaintAnalysis', () => {
		if (SWAN_STARTED && PROJECT_COMPILED && !COMPILING) {
			vscode.window.showInformationMessage("Running taint analysis...");
			io.to(GLOBAL_SOCKET).emit("runTaintAnalysis");
		} else if (!SWAN_STARTED && !PROJECT_COMPILED && !COMPILING) {
			vscode.commands.executeCommand("swan.startSWAN");
		} else if (SWAN_STARTED && !PROJECT_COMPILED && !COMPILING) {
			vscode.commands.executeCommand("swan.compile");
		}
	});

	let taintAnalysisResults = vscode.commands.registerCommand('swan.taintAnalysisResults', () => {
		vscode.window.createTreeView(
			'taintAnalysisSideBar',
			{
				treeDataProvider: pathProvider
			}
		);
		vscode.window.showInformationMessage("Finished taint analysis...");
	});

	let startSWAN = vscode.commands.registerCommand('swan.startSWAN', () => {
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
				GLOBAL_SOCKET = socket.id;
				vscode.window.showInformationMessage("Connected to SWAN JVM");
				SWAN_STARTED = true;
				clearTimeout(timer);
				vscode.commands.executeCommand("swan.compile");

				socket.on('taintAnalysisResults', (json : any) => {
					pathProvider.setPaths(json);
					vscode.commands.executeCommand('swan.taintAnalysisResults');
				});
				
				socket.on('disconnect', (data : any) => {
					io.off();
				});

				socket.on('error', (e : any) => {
					vscode.window.showErrorMessage("JVM error: " + e);
				});
			});
			io.listen(4040);

			vscode.window.showInformationMessage("Looking for existing SWAN JVM process...");

			timer = setTimeout((() => {
				if (!SWAN_STARTED) {
					vscode.window.showInformationMessage("Starting SWAN JVM...");

					const command = 
						"/." + process.env.PATH_TO_SWAN + 
						"/gradlew run -p " + process.env.PATH_TO_SWAN + " " +
						"-Dorg.gradle.jvmargs=\"" + 
						vscode.workspace.getConfiguration('swan').get('JVMOptions') + "\"";
					let script = exec(command, {encoding : 'utf-8'},  
						(error : any, stdout : any , stderr : any) => {
							if (error !== null) {
								vscode.window.showErrorMessage("Something went wrong with the JVM: " + stderr);
								SWAN_STARTED = false;
							}
						});
				}
			}), 5000); // Generous 5 seconds since this is how long it can take to see if a JVM is already listening.
		} catch (e) {
			vscode.window.showWarningMessage("Could not start SWAN: " + e);
			SWAN_STARTED = false;
		}
	});

	let stopSWAN = vscode.commands.registerCommand('swan.stopSWAN', () => {
		try {
			io.to(GLOBAL_SOCKET).emit("disconnect");
		} catch (e) {
			vscode.window.showErrorMessage("Could not stop SWAN JVM: " + e);
		}
	});

	let generateDataFlow = vscode.commands.registerCommand('swan.compile', () => {
		// Call SWAN operation based off settings.json.
		const SWANConfig = vscode.workspace.getConfiguration('swan');
		if (SWANConfig.get("ProjectType") === "XCode Project") {
			let err = false;
			if (SWANConfig.get("XCodeScheme") === "REPLACE ME") {
				vscode.window.showErrorMessage("XCode scheme not set!");
				err = true;
			}
			if (SWANConfig.get("XCodeProjectPath") === "REPLACE ME") {
				vscode.window.showErrorMessage("XCode project path not set!");
				err = true;
			}
			if (!err) {

				vscode.window.showInformationMessage("Compiling XCode project...");
				COMPILING = true;

				const command = 
					"xcodebuild clean build -project " + 
					SWANConfig.get("XCodeProject") + 
					" -scheme " + SWANConfig.get("XCodeScheme") + " " +
					SWANConfig.get("XCodeOptions") + 
					"SWIFT_COMPILATION_MODE=wholemodule SWIFT_OPTIMIZATION_LEVEL=-Onone SWIFT_EXEC=" +
					process.env.PATH_TO_SWAN + "/ca.maple.swan.translator/argumentWriter.py";

				let script = exec(command, {encoding : 'utf-8'},  
					(error : any, stdout : any , stderr : any) => {
						if (error !== null) {
							vscode.window.showErrorMessage("Could not build XCode project: " + stderr);
							console.log("error");
							return;
						} else {
							fs.readFile("/tmp/SWAN_arguments.txt", {encoding: 'utf-8'}, function(err:any, args:any){
								if (!err) {
									console.log(args);
									// When finished
									COMPILING = false;
									vscode.commands.executeCommand("swan.runTaintAnalysis");
								} else {
									vscode.window.showErrorMessage("Could not open intercept swiftc arguments!");
									COMPILING = false;
									return;
								}
							});
						}
					});
			}
			
			if (err) { 
				vscode.window.showErrorMessage("Could not compile XCode application");
				return; 
			}
		} else { // "Single file" mode
			let err = false;
			if (SWANConfig.get("SingleFilePath") === "REPLACE ME") {
				vscode.window.showErrorMessage("Single file path not set!");
			}
			
			if (!err) {
				vscode.window.showInformationMessage("Compiling Swift file...");
			}

			if (err) {
				vscode.window.showErrorMessage("Could not compile Swift application");
				return;
			}
			
		}

		// If successful, call this.
		PROJECT_COMPILED = true;
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
	if (GLOBAL_SOCKET !== undefined) {
		vscode.commands.executeCommand("swan.stopSWAN");
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