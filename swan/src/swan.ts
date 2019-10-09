import * as vscode from 'vscode';
import * as tree from './tree';
const exec = require('child_process').exec;
const io = require('socket.io')();
const fs = require('fs');

// Flags for keeping track of program state. 
let GLOBAL_SOCKET : any = undefined;
let SWAN_STARTED = false;
let PROJECT_COMPILED = false; // Includes SDG step.
let COMPILING = false;

let timer : NodeJS.Timeout;

interface SSSJson {
	Sources: string[] | undefined;
	Sinks: string[] | undefined;
	Sanitizers: string[] | undefined ;
}

export function activate(context: vscode.ExtensionContext) {

	// Create tree data provider to be later populated.
	let pathProvider = new tree.TaintAnalysisPathProvider();

	// Main activation event. Has three stages:
	// 1. Start SWAN JVM
	// 2. Compile Swift file or XCode project
	// 3. Run taint analysis
	let runTaintAnalysis = vscode.commands.registerCommand('swan.runTaintAnalysis', () => {
		if (SWAN_STARTED && PROJECT_COMPILED && !COMPILING) {
			vscode.window.showInformationMessage("Running taint analysis...");
			const SWANConfig = vscode.workspace.getConfiguration('swan');
			let sss : SSSJson = {
				"Sources" : (SWANConfig.get("Sources") !== undefined) ? SWANConfig.get("Sources") : [], 
				"Sinks" : (SWANConfig.get("Sinks") !== undefined) ? SWANConfig.get("Sinks") : [], 
				"Sanitizers" : (SWANConfig.get("Sanitizers") !== undefined) ? SWANConfig.get("Sanitizers") : []
			};
			io.to(GLOBAL_SOCKET).emit("runTaintAnalysis", sss);
		} else if (!SWAN_STARTED && !PROJECT_COMPILED && !COMPILING) {
			vscode.commands.executeCommand("swan.startSWAN");
		} else if (SWAN_STARTED && !PROJECT_COMPILED && !COMPILING) {
			vscode.commands.executeCommand("swan.compile");
		}
	});

	let taintAnalysisResults = vscode.commands.registerCommand('swan.taintAnalysisResults', () => {
		// Show/reset tree view.
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
			// Make sure user has PATH_TO_SWAN set which is required by both the
			// extension and SWAN itself.
			if (process.env.PATH_TO_SWAN === undefined) {
				vscode.window.showErrorMessage(
					"Environment variable PATH_TO_SWAN not set!", 'Learn More')
					.then(_ => {
						vscode.env.openExternal(vscode.Uri.parse('https://github.com/themaplelab/swan'));
					});
				return;
			}

			io.on('connection', (socket : any) => { 

				// Keep track of sole connection.
				GLOBAL_SOCKET = socket.id;
				
				vscode.window.showInformationMessage("Connected to SWAN JVM");
				SWAN_STARTED = true;

				// Clear the timer since we have connected to the JVM.
				clearTimeout(timer);

				// Compile the application immediately. 
				vscode.commands.executeCommand("swan.compile");

				// Handle when the JVM returns the taint analysis results.
				socket.on('taintAnalysisResults', (json : any) => {
					pathProvider.setPaths(json);
					vscode.commands.executeCommand('swan.taintAnalysisResults');
				});
				
				// When disconnected, stop listening.
				socket.on('disconnect', (data : any) => {
					io.off();
				});

				socket.on('generatedSDG', () => {
					PROJECT_COMPILED = true;
					vscode.window.showInformationMessage("Done compilation");
					vscode.commands.executeCommand('swan.runTaintAnalysis');
				});

				// JVM should report any errors to this handler.
				socket.on('error', (e : any) => {
					vscode.window.showErrorMessage("JVM error: " + e);
				});
			});
			io.listen(4040);

			vscode.window.showInformationMessage("Looking for existing SWAN JVM process...");

			// Wait 5 seconds before starting up a new JVM to see if there is one running already.
			// To debug the JVM, it must be already running so this step is necessary. May be
			// blown away later to minimize inconvenience to the user.
			timer = setTimeout((() => {
				if (!SWAN_STARTED) {
					vscode.window.showInformationMessage("Starting SWAN JVM...");

					const command = 
						"/." + process.env.PATH_TO_SWAN + 
						"/gradlew run -p " + process.env.PATH_TO_SWAN + " " +
						"-Dorg.gradle.jvmargs=\"" + 
						vscode.workspace.getConfiguration('swan').get('JVMOptions') + "\"";

					// Async gradle command execution. We only know if this command truly worked
					// if we get the "connection" socket event.
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
			// Just in case.
			vscode.window.showWarningMessage("Could not start SWAN: " + e);
			SWAN_STARTED = false;
		}
	});

	// This command is invoked by the deactivate() call, and it shuts down
	// the JVM.
	let stopSWAN = vscode.commands.registerCommand('swan.stopSWAN', () => {
		try {
			io.to(GLOBAL_SOCKET).emit("disconnect");
		} catch (e) {
			vscode.window.showErrorMessage("Could not stop SWAN JVM: " + e);
		}
	});

	// This command compiles the Swift file or XCode project.
	let generateDataFlow = vscode.commands.registerCommand('swan.compile', () => {
		// Make sure that the settings needed to compile for the selected
		// mode are set.
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

				vscode.window.showInformationMessage("Compiling and translating XCode project. This may take a while...");

				// Flag in case the user tries to compile again during the compilation process.
				COMPILING = true;

				const command = 
					"xcodebuild clean build -project " + 
					SWANConfig.get("XCodeProjectPath") + 
					" -scheme " + SWANConfig.get("XCodeScheme") + " " +
					SWANConfig.get("XCodeOptions") + 
					" SWIFT_COMPILATION_MODE=wholemodule SWIFT_OPTIMIZATION_LEVEL=-Onone SWIFT_EXEC=" +
					process.env.PATH_TO_SWAN + "/ca.maple.swan.translator/argumentWriter.py";

				// Async command that calls `xcodebuild` and, when finished, reads the intercepted arguments
				// from the designated tmp file.
				let script = exec(command, {encoding : 'utf-8'},  
					(error : any, stdout : any , stderr : any) => {
						if (error !== null) {
							vscode.window.showErrorMessage("Could not build XCode project: " + stderr);
							COMPILING = false;
							return;
						} else {
							fs.readFile("/tmp/SWAN_arguments.txt", {encoding: 'utf-8'}, function(err:any, args:any){
								if (!err) {
									// Convert args, generate SDG.
									convertArgs(args)
										.then((convertedArgs) => {
											io.to(GLOBAL_SOCKET).emit("generateSDG", convertedArgs);
										})
										.catch((e) => {
											vscode.window.showErrorMessage("Could not convert arguments: " + e);
										});

								} else {
									vscode.window.showErrorMessage("Could not open intercept swiftc arguments!");
								}
								COMPILING = false;
							});
						}
					});
			} else { 
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
	});

	// Command that opens the selected file in the file tree. 
	// TODO: Add a position.
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

async function convertArgs(args : string) : Promise<string[]> {
	return new Promise((resolve, reject) => {
		const command = 
		"swiftc " + args + " -Onone -whole-module-optimization -driver-print-jobs";
		let script = exec(command, {encoding : 'utf-8'},  
			(error : any, jobs : any , stderr : any) => {
				jobs = jobs.replace(/(\r\n|\n|\r)/gm,"");
				if (error !== null) {
					reject(stderr);
				} else {
					let arrJobs : string[] = jobs.split(" ");
					arrJobs.splice(0, 2);
					const idx = arrJobs.indexOf("-supplementary-output-file-map");
					if (idx > -1) {
						arrJobs = arrJobs.slice(0, idx).concat(arrJobs.slice(idx + 2, arrJobs.length));
					}
					arrJobs = ["", "-emit-silgen"].concat(arrJobs);
					resolve(arrJobs);
				}
			});
	});	
}