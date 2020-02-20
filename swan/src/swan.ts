import * as vscode from 'vscode';
import * as tree from './tree';
import { TaintAnalysisPathsJSON } from './tree';
const exec = require('child_process').exec;
const io = require('socket.io')();
const fs = require('fs');

// Flags for keeping track of program state. 
let GLOBAL_SOCKET : any = undefined;
let SWAN_STARTED = false;
let PROJECT_COMPILED = false; // Includes translation step.
let COMPILING = false;
vscode.commands.executeCommand("setContext", "recompileON", false);

let functionNames : string[] = ["testTaint.source() -> Swift.String"];

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
            reportInfo("Running taint analysis..." + '\n');
			const SWANConfig = vscode.workspace.getConfiguration('swan');
			let sss : SSSJson = {"Sources" : [], "Sinks" : [], "Sanitizers" : []};
			if (SWANConfig.get('TaintAnalysisMode') === "Refined") {
				let CustomSSS : any = SWANConfig.get("CustomSSS");
				sss = {
					"Sources" : (CustomSSS["Sources"] !== undefined) ? CustomSSS["Sources"] : [], 
					"Sinks" : (CustomSSS["Sinks"] !== undefined) ? CustomSSS["Sinks"] : [], 
					"Sanitizers" : (CustomSSS["Sanitizers"] !== undefined) ? CustomSSS["Sanitizers"] : []
				};
			}
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
        reportInfo("Finished taint analysis...");
	});

	let startSWAN = vscode.commands.registerCommand('swan.startSWAN', () => {
		try {
			// Make sure user has PATH_TO_SWAN set which is required by both the
			// extension and SWAN itself.
			if (process.env.PATH_TO_SWAN === undefined) {
                let errStr = "Environment variable PATH_TO_SWAN not set!";
				vscode.window.showErrorMessage(
					errStr, 'Learn More')
					.then(_ => {
						vscode.env.openExternal(vscode.Uri.parse('https://github.com/themaplelab/swan'));
                    });
                console.error(errStr);
				return;
			}

			io.on('connection', (socket : any) => { 

				// Keep track of sole connection.
				GLOBAL_SOCKET = socket.id;
                
                reportInfo("Connected to SWAN JVM");
				SWAN_STARTED = true;

				// Clear the timer since we have connected to the JVM.
				clearTimeout(timer);

				// Compile the application immediately. 
				vscode.commands.executeCommand("swan.compile");

				// Handle when the JVM returns the taint analysis results.
				socket.on('taintAnalysisResults', (json : TaintAnalysisPathsJSON) => {
					pathProvider.setPaths(json);
					functionNames = json.functions;
					vscode.commands.executeCommand('swan.taintAnalysisResults');
				});
				
				// When disconnected, stop listening.
				socket.on('disconnect', (data : any) => {
                    io.off();
                    reportInfo("Disconnected from SWAN JVM");
					SWAN_STARTED = false;
					PROJECT_COMPILED = false;
					vscode.commands.executeCommand("setContext", "recompileON", false);
					COMPILING = false; 
				});

				socket.on('translated', () => {
					PROJECT_COMPILED = true;
                    vscode.commands.executeCommand("setContext", "recompileON", true);
                    reportInfo("Done compilation");
					vscode.commands.executeCommand('swan.runTaintAnalysis');
				});

				// JVM should report any errors to this handler.
				socket.on('error', (e : any) => {
                    reportError("JVM error: " + e);
				});
			});
			io.listen(4040);

            reportInfo("Looking for existing SWAN JVM process...");

			// Wait 5 seconds before starting up a new JVM to see if there is one running already.
			// To debug the JVM, it must be already running so this step is necessary. May be
			// blown away later to minimize inconvenience to the user.
			timer = setTimeout((() => {
				if (!SWAN_STARTED) {
                    reportInfo("Starting SWAN JVM...");

					const command = 
						"/." + process.env.PATH_TO_SWAN + 
						"/gradlew run -p " + process.env.PATH_TO_SWAN + " " +
						"-Dorg.gradle.jvmargs=\"" + 
						vscode.workspace.getConfiguration('swan').get('JVMOptions') + "\"";

					// Async gradle command execution. We only know if this command truly worked
                    // if we get the "connection" socket event.
                    console.log("Running: " + command + '\n');
					let script = exec(command, {encoding : 'utf-8'},  
						(error : any, stdout : any , stderr : any) => {
							if (error !== null) {                  
                                reportError("Something went wrong with the JVM: " + stderr);
								SWAN_STARTED = false;
							}
						});
				}
			}), 5000); // Generous 5 seconds since this is how long it can take to see if a JVM is already listening.
		} catch (e) {
            // Just in case.
            reportWarning("Could not start SWAN: " + e);
			SWAN_STARTED = false;
		}
	});

	// This command is invoked by the deactivate() call, and it shuts down
	// the JVM.
	let stopSWAN = vscode.commands.registerCommand('swan.stopSWAN', () => {
		try {
			io.to(GLOBAL_SOCKET).emit("disconnect");
		} catch (e) {
            reportError("Could not stop SWAN JVM: " + e);
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
                reportError("XCode scheme not set!");
				err = true;
			}

			if (SWANConfig.get("XCodeProjectPath") === "REPLACE ME") {
                reportError("XCode project path not set!");
				err = true;
			}

			if (!err) {

                reportInfo("Compiling and translating XCode project. This may take a while...");

				// Flag in case the user tries to compile again during the compilation process.
				COMPILING = true;

				const command = 
					"xcodebuild clean build -project " + 
					SWANConfig.get("XCodeProjectPath") + 
					" -scheme " + SWANConfig.get("XCodeScheme") + " " +
					SWANConfig.get("XCodeOptions") + 
					" SWIFT_COMPILATION_MODE=wholemodule SWIFT_OPTIMIZATION_LEVEL=-Onone SWIFT_EXEC=" +
					process.env.PATH_TO_SWAN + "/utils/argumentWriter"; // This should probably exist in the vscode extension instead.

				// Async command that calls `xcodebuild` and, when finished, reads the intercepted arguments
                // from the designated tmp file.
                console.log("Running: " + command + '\n');
				let script = exec(command, {encoding : 'utf-8'},  
					(error : any, stdout : any , stderr : any) => {
						if (error !== null) {
                            reportError("Could not build XCode project: " + stderr);
                            COMPILING = false;
							return;
						} else {
							fs.readFile("/tmp/SWAN_arguments.txt", {encoding: 'utf-8'}, function(err:any, args:any){
								if (!err) {
									// Convert args, do translation.
									convertArgs(args)
										.then((convertedArgs) => {
											io.to(GLOBAL_SOCKET).emit("doTranslation", convertedArgs);
										})
										.catch((e) => {
                                            reportError("Could not convert arguments: " + e);
										});

								} else {
                                    reportError("Could not open intercept swiftc arguments!");
								}
								COMPILING = false;
							});
						}
					});
			} else { 
                reportError("Could not compile XCode application");
				return; 
			}
		} else { // "Single file" mode
			let err = false;
			if (SWANConfig.get("SingleFilePath") === "REPLACE ME") {
                reportError("Single file path not set!");
			}
			
			if (!err) {
                reportInfo("Compiling and translating Swift file...");
			}

			var args = ["", "-emit-silgen", "-Onone", SWANConfig.get("SingleFilePath")];

			if (SWANConfig.get("SDKPath") !== "") {
				args.push("-sdk");
				args.push(SWANConfig.get("SDKPath"));
			}

			io.to(GLOBAL_SOCKET).emit("doTranslation", args);

			if (err) {
                reportError("Could not compile Swift application");
				return;
			}
			
		}
	});

	let recompile = vscode.commands.registerCommand('swan.recompile', () => {
		vscode.commands.executeCommand("swan.compile");
	});

	let openFileCommand = vscode.commands.registerCommand('openFile', (filename : string, options : vscode.TextDocumentShowOptions) => {
		vscode.workspace.openTextDocument(filename).then(doc => {
			vscode.window.showTextDocument(doc, options);
		});
	});

	let provider = vscode.languages.registerCompletionItemProvider({ language: 'jsonc', scheme: 'vscode-userdata' }, {

		provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext) {
			let completions : vscode.CompletionItem[] = [];
			functionNames.forEach((s : string) => {
				const completionItem  = new vscode.CompletionItem('\"' + s + '\"', vscode.CompletionItemKind.Text);
				// completionItem.commitCharacters = ['\"'];
				completions.push(completionItem);
			});
			return completions;
		}
	});
		
	context.subscriptions.push(openFileCommand);
	context.subscriptions.push(runTaintAnalysis);
	context.subscriptions.push(taintAnalysisResults);
	context.subscriptions.push(startSWAN);
	context.subscriptions.push(stopSWAN);
	context.subscriptions.push(generateDataFlow);
	context.subscriptions.push(recompile);
	context.subscriptions.push(provider);
}

export function deactivate() {
	if (GLOBAL_SOCKET !== undefined) {
		vscode.commands.executeCommand("swan.stopSWAN");
	}
}

export class OpenFileCommand implements vscode.Command {
	title: string = 'Open File';	
	command: string = 'openFile';
	tooltip?: string | undefined;
	arguments?: any[] | undefined;

	constructor(filename : string, rng : vscode.Range) {
		this.arguments = [filename, <vscode.TextDocumentShowOptions>({selection : rng})];
	}
}

async function convertArgs(args : string) : Promise<string[]> {
	return new Promise((resolve, reject) => {
		const command = 
        "swiftc " + args + " -Onone -whole-module-optimization -driver-print-jobs";
        console.log("Running: " + command + '\n');
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

function reportInfo(s : String) {
    vscode.window.showInformationMessage(<any>s);
    console.info(s + '\n');
}

function reportError(s : String) {
    vscode.window.showErrorMessage(<any>s);
    console.error(s + '\n');
}

function reportWarning(s : String) {
    vscode.window.showWarningMessage(<any>s);
    console.warn(s + '\n');
}