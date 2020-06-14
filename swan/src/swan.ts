import * as vscode from 'vscode';
import * as tree from './tree';
import { TaintAnalysisPathsJSON } from './tree';
const exec = require('child_process').exec;
const socketIO = require('socket.io');
const fs = require('fs');

// Flags for keeping track of program state. 
let GLOBAL_SOCKET : any = undefined;
let currentIO : any = undefined;
let SWAN_STARTED = false;
let PROJECT_COMPILED = false; // Includes translation step.
let COMPILING = false;
vscode.commands.executeCommand("setContext", "recompileON", false);
vscode.commands.executeCommand("setContext", "swanRunning", false);

let functionNames : string[] = [];

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
	// 2. Compile Swift file.
	// 3. Run taint analysis
	let runTaintAnalysis = vscode.commands.registerCommand('swan.runTaintAnalysis', () => {
		if (SWAN_STARTED && PROJECT_COMPILED && !COMPILING) {
            reportInfo("Running taint analysis...");
			const SWANConfig = vscode.workspace.getConfiguration('swan');
			let sss : SSSJson = {"Sources" : [], "Sinks" : [], "Sanitizers" : []};
			if (SWANConfig.get('TaintAnalysisMode') === "Refined") {
                let CustomSSS : any = SWANConfig.get("CustomSSS");
				sss = {
					"Sources" : (CustomSSS["swan.Sources"] !== undefined) ? CustomSSS["swan.Sources"] : [], 
					"Sinks" : (CustomSSS["swan.Sinks"] !== undefined) ? CustomSSS["swan.Sinks"] : [], 
					"Sanitizers" : (CustomSSS["swan.Sanitizers"] !== undefined) ? CustomSSS["swan.Sanitizers"] : []
                };
            }
			currentIO.to(GLOBAL_SOCKET).emit("runTaintAnalysis", sss);
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
                let errStr = "[ERROR] Environment variable PATH_TO_SWAN not set!";
				vscode.window.showErrorMessage(
					errStr, 'Learn More')
					.then(_ => {
						vscode.env.openExternal(vscode.Uri.parse('https://github.com/themaplelab/swan'));
                    });
                console.error(errStr);
				return;
            }

            let io = socketIO({forceNew : true});

            currentIO = io;

			io.on('connection', (socket : any) => { 
                reportIOEvent("connection from " + socket.id);

                // Reject connections if a JVM is (presumably) already running.
                if (SWAN_STARTED) {
                    io.to(socket.id).emit("rejected");
                    reportWarning("Rejected unexpected connection.");
                    return;
                }

                // Keep track of sole connection.
				GLOBAL_SOCKET = socket.id;
                
                reportInfo("Connected to SWAN JVM");
                SWAN_STARTED = true;
                vscode.commands.executeCommand("setContext", "swanRunning", true);

				// Clear the timer since we have connected to the JVM.
				clearTimeout(timer);

				// Compile the application immediately. 
				vscode.commands.executeCommand("swan.compile");

				// Handle when the JVM returns the taint analysis results.
				socket.on('taintAnalysisResults', (json : TaintAnalysisPathsJSON) => {
                    reportIOEvent("taintAnalysisResults");
					pathProvider.setPaths(json);
					functionNames = json.functions;
					vscode.commands.executeCommand('swan.taintAnalysisResults');
				});
				
				// When disconnected, stop listening and reset everything.
				socket.on('disconnect', (data : any) => {
                    reportIOEvent("disconnect: " + data);
                    reportInfo("Disconnected from SWAN JVM");
                    resetAll();
                    io.close();
				});

				socket.on('translated', () => {
                    reportIOEvent("translated");
					PROJECT_COMPILED = true;
                    vscode.commands.executeCommand("setContext", "recompileON", true);
                    reportInfo("Done compilation");
					vscode.commands.executeCommand('swan.runTaintAnalysis');
				});

				// JVM should report any errors to this handler.
				socket.on('error', (e : any) => {
                    reportIOEvent("error");
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
						"/." + process.env.PATH_TO_SWAN + "/bin/swan-server " +
						vscode.workspace.getConfiguration('swan').get('JVMOptions');

					// Async gradle command execution. We only know if this command truly worked
                    // if we get the "connection" socket event.
                    reportInfo("Running: " + command);
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

    // This command can be invoked by a UI command after the JVM is connected to.
	let stopSWAN = vscode.commands.registerCommand('swan.stopSWAN', () => {
		try {
            reportInfo("Attempting to disconnect from JVM...");
            currentIO.to(GLOBAL_SOCKET).emit("disconnect");
            setTimeout(function() {
                if (SWAN_STARTED) {
                    // We use blocking sockets, unfortunately. 
                    reportWarning("No response from JVM, perhaps its busy.");
                }
            }, 2000);
		} catch (e) {
            reportError("Could not stop SWAN JVM: " + e);
		}
	});

	// This command compiles the Swift file.
	let generateDataFlow = vscode.commands.registerCommand('swan.compile', () => {
		// Make sure that the settings needed to compile for the selected
		// mode are set.
		const SWANConfig = vscode.workspace.getConfiguration('swan');

        let err = false;
        if (SWANConfig.get("SwiftFilePath") === "REPLACE ME") {
            reportError("Swift file path not set!");
        }
        
        if (!err) {
            reportInfo("Compiling and translating Swift file...");
        }

        var args = ["-emit-silgen", "-Onone", SWANConfig.get("SwiftFilePath")];

        if (SWANConfig.get("SDKPath") !== "") {
            args.push("-sdk");
            args.push(SWANConfig.get("SDKPath"));
        }

        currentIO.to(GLOBAL_SOCKET).emit("doTranslation", args, "WALA");

        if (err) {
            reportError("Could not compile Swift application");
            return;
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

function resetAll() {
    SWAN_STARTED = false;
    PROJECT_COMPILED = false;
    COMPILING = false;
    vscode.commands.executeCommand("setContext", "recompileON", false);
    vscode.commands.executeCommand("setContext", "swanRunning", false);
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

function reportIOEvent(event : String) {
    console.info("[IO Event] " + event + "\n");
}

function reportInfo(s : String) {
    vscode.window.showInformationMessage(<any>s);
    console.info("[INFO] " + s + '\n');
}

function reportError(s : String) {
    vscode.window.showErrorMessage(<any>s);
    console.error("[ERROR] " + s + '\n');
}

function reportWarning(s : String) {
    vscode.window.showWarningMessage(<any>s);
    console.warn("[WARN] " + s + '\n');
}