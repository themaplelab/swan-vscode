import * as vscode from 'vscode';
import * as commands from './swan';
var path = require("path");


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

export class TaintAnalysisPathProvider implements vscode.TreeDataProvider<vscode.TreeItem> {

	onDidChangeTreeData?: vscode.Event<vscode.TreeItem|null|undefined>|undefined;

	data : TaintPath[] = [];

	setPaths(json : TaintAnalysisPathsJSON) : void {
        this.data = [];
		json.paths.forEach((p : PathsEntity) => {
			const name = p.pathName;
			let counter : number = 0;
			let elements : PathElement[] = [];
			p.elements.forEach((element : ElementEntity) => {
				if (counter === 0) {
					elements.push(new SourceElement(
						path.parse(element.file).base, 
						new commands.OpenFileCommand(element.file)));
				} else if (counter === p.elements.length - 1) {
					elements.push(new SinkElement(
						path.parse(element.file).base, 
						new commands.OpenFileCommand(element.file)));
				} else {
					elements.push(new IntermediateElement(
						path.parse(element.file).base, 
						new commands.OpenFileCommand(element.file)));
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
