import * as vscode from 'vscode';
var path = require("path");


export function activate(context: vscode.ExtensionContext) {

	let disposable = vscode.commands.registerCommand('extension.dataflow', () => {

		let pathProvider = new TaintAnalysisPathProvider()

		pathProvider.addPath({'name':'path1', 'elements':['/Users/tiganov/Documents/CS/proj/TestMultiFile/TestMultiFile/main.swift', '/Users/tiganov/Documents/CS/proj/TestMultiFile/TestMultiFile/secondFile.swift']});

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
	
	context.subscriptions.push(openFileCommand)
	context.subscriptions.push(disposable);
}


// this method is called when your extension is deactivated
export function deactivate() {}


class TaintAnalysisPathProvider implements vscode.TreeDataProvider<vscode.TreeItem> {

	onDidChangeTreeData?: vscode.Event<vscode.TreeItem|null|undefined>|undefined;

	data : TaintPath[] = []

	addPath(json : any) : void {
		const name = json['name'] 
		let elements : PathElement[] = []
		json['elements'].forEach((elementName: any) => {
			elements.push(new PathElement(path.parse(elementName).base, new OpenFileCommand(elementName)))
		});
		this.data.push(new TaintPath(name, elements))
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

	children : PathElement[] = []

	constructor(
		public readonly label: string,
		public readonly elements: PathElement[], 
		public readonly command?: vscode.Command
	) {
		super(label, 1);
		this.children = elements;
	}

	getChildren() : PathElement[] {
		return this.children
	}
}

class PathElement extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		public readonly command?: vscode.Command
	) {
		super(label, 0);
		this.command = command
	}

}

class OpenFileCommand implements vscode.Command {
	title: string = 'Open File';	command: string = 'openFile';
	tooltip?: string | undefined;
	arguments?: any[] | undefined;

	constructor(filename : string) {
		this.arguments = [filename]
	}

}