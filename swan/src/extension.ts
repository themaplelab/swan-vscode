import * as vscode from 'vscode';
var path = require("path");
var http = require('http');

var port = 8081;

// NOTES:
// Implicit that the first element is the source and the last is the sink.

export interface TaintAnalysisPathsJSON {
	paths: PathsEntity[];
}
export interface PathsEntity {
	pathName: string;
	elements: ElementEntity[];
}
export interface ElementEntity {
	file: string;
	location: string;
}

export function activate(context: vscode.ExtensionContext) {

	let pathProvider = new TaintAnalysisPathProvider();

	let disposable = vscode.commands.registerCommand('extension.dataflow', () => {

		vscode.window.createTreeView(
			'taintAnalysisPanel',
			{
				treeDataProvider: pathProvider
			}
		);
		
	});

	let openFileCommand = vscode.commands.registerCommand('openFile', (filename : string) => {
		vscode.workspace.openTextDocument(filename).then(doc => {
			vscode.window.showTextDocument(doc);

		});
	});

	let start = vscode.commands.registerCommand('extension.start', () => {
		var server = http.createServer();
		server.on('request', function(request : any, response : any) {
			if (request.method === 'POST') {
				request.on('data', function(data : any) {
					pathProvider.addPath(JSON.parse(data));
					vscode.commands.executeCommand('extension.dataflow');
					response.writeHead(200);
					response.end();
				});
			}
		});
		 
		server.listen(port);
	});
		
	context.subscriptions.push(openFileCommand);
	context.subscriptions.push(disposable);
	context.subscriptions.push(start);
}


// this method is called when your extension is deactivated
export function deactivate() {}


class TaintAnalysisPathProvider implements vscode.TreeDataProvider<vscode.TreeItem> {

	onDidChangeTreeData?: vscode.Event<vscode.TreeItem|null|undefined>|undefined;

	data : TaintPath[] = [];

	addPath(json : TaintAnalysisPathsJSON) : void {
		json.paths.forEach((p : PathsEntity) => {
			const name = p.pathName;
			let counter : number = 0;
			let elements : PathElement[] = [];
			p.elements.forEach((element : ElementEntity) => {
				if (counter === 0) {
					elements.push(new SourceElement(
						path.parse(element.file).base, 
						new OpenFileCommand(element.file)));
				} else if (counter === p.elements.length - 1) {
					elements.push(new SinkElement(
						path.parse(element.file).base, 
						new OpenFileCommand(element.file)));
				} else {
					elements.push(new IntermediateElement(
						path.parse(element.file).base, 
						new OpenFileCommand(element.file)));
				}
				counter++;
			});
			this.data.push(new TaintPath(name, elements));
		});
	}

	getTreeItem(element: any): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element;
	}

	getChildren(element?: any): vscode.ProviderResult<vscode.TreeItem[]> {
		if (element === undefined) {
			return this.data;
		  }
		return element.children;
	}
}

class TaintPath extends vscode.TreeItem {

	children : PathElement[] = [];

	constructor(
		public readonly label: string,
		public readonly elements: PathElement[], 
		public readonly command?: vscode.Command
	) {
		super(label, 1);
		this.children = elements;
		this.tooltip = "Dangerous path";
	}

	getChildren() : PathElement[] {
		return this.children;
	}

	iconPath = {
		light: path.join(__filename, '..', '..', 'resources', 'light', 'path_light.svg'),
		dark: path.join(__filename, '..', '..', 'resources', 'dark', 'path_dark.svg')
	};
}

abstract class PathElement extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		public readonly command?: vscode.Command
	) {
		super(label, 0);
		this.command = command;
	}
}

class SourceElement extends PathElement {

	constructor(
		public readonly label: string,
		public readonly command?: vscode.Command
	) {
		super(label);
		this.tooltip = "Source";
	}

	iconPath = {
		light: path.join(__filename, '..', '..', 'resources', 'light', 'source_light.svg'),
		dark: path.join(__filename, '..', '..', 'resources', 'dark', 'source_dark.svg')
	};
}

class IntermediateElement extends PathElement {

	constructor(
		public readonly label: string,
		public readonly command?: vscode.Command
	) {
		super(label);
		this.tooltip = "Intermediate";
	}

	iconPath = {
		light: path.join(__filename, '..', '..', 'resources', 'light', 'intermediate_light.svg'),
		dark: path.join(__filename, '..', '..', 'resources', 'dark', 'intermediate_dark.svg')
	};
}

class SinkElement extends PathElement {

	constructor(
		public readonly label: string,
		public readonly command?: vscode.Command
	) {
		super(label);
		this.tooltip = "Sink";
	}

	iconPath = {
		light: path.join(__filename, '..', '..', 'resources', 'light', 'sink_light.svg'),
		dark: path.join(__filename, '..', '..', 'resources', 'dark', 'sink_dark.svg')
	};
}

class OpenFileCommand implements vscode.Command {
	title: string = 'Open File';	command: string = 'openFile';
	tooltip?: string | undefined;
	arguments?: any[] | undefined;

	constructor(filename : string) {
		this.arguments = [filename];
	}
}