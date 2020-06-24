import * as fs from "fs";
import { cloneDeep, merge } from "lodash";
import { sep } from "path";
import { delay, map as mapObservable, scan } from "rxjs/operators";
import { TextDocument, TextEdit } from "vscode-languageserver-protocol";
import { TextDocumentWillSaveEvent, Uri, workspace } from "coc.nvim";

import {
  defaultGeneralConfiguration,
  GeneralConfiguration,
  ImportRunner,
  ImportSorterConfiguration,
  ImportStringConfiguration,
  InMemoryImportCreator,
  InMemoryImportSorter,
  SimpleImportAstParser,
  SimpleImportRunner,
  SortConfiguration,
} from "./core/core-public";
import { ConfigurationProvider } from "./core/import-runner";

const EXTENSION_CONFIGURATION_NAME = "importSorter";

export class VSCodeConfigurationProvider implements ConfigurationProvider {
  private currentConfiguration: ImportSorterConfiguration;
  public getConfiguration(): ImportSorterConfiguration {
    return this.currentConfiguration;
  }

  public resetConfiguration() {
    this.currentConfiguration = this._getConfiguration();
  }

  private _getConfiguration() {
    const generalConfigProxy:
      | GeneralConfiguration
      | ProxyHandler<GeneralConfiguration> = workspace
      .getConfiguration(EXTENSION_CONFIGURATION_NAME)
      .get<GeneralConfiguration>("generalConfiguration");
    const generalConfig = cloneDeep(generalConfigProxy);

    const configPath = `${workspace.rootPath}${sep}${generalConfig.configurationFilePath}`;
    const isConfigExist = fs.existsSync(configPath);

    if (
      !isConfigExist &&
      generalConfig.configurationFilePath !==
        defaultGeneralConfiguration.configurationFilePath
    ) {
      console.error(
        "configurationFilePath is not found by the following path, import sorter will proceed with defaults from settings",
        configPath
      );
      // @TODO: find way to display error in status bar
      // window.showErrorMessage(
      //   "configurationFilePath is not found by the following path, import sorter will proceed with defaults from settings",
      //   configPath
      // );
    }

    const fileConfigurationString = isConfigExist
      ? fs.readFileSync(configPath, "utf8")
      : "{}";
    const fileConfigJsonObj = JSON.parse(fileConfigurationString);
    const fileConfigMerged = Object.keys(fileConfigJsonObj)
      .map((key) => {
        const total = {};
        const keys = key.split(".").filter((str) => str !== "importSorter");
        keys.reduce((sum, currentKey, index) => {
          if (index === keys.length - 1) {
            sum[currentKey] = fileConfigJsonObj[key];
          } else {
            sum[currentKey] = {};
          }
          return sum[currentKey];
        }, total);
        return total;
      })
      .reduce((sum, currentObj) => merge(sum, currentObj), {});
    const fileConfig = fileConfigMerged as ImportSorterConfiguration;
    const sortConfigProxy:
      | SortConfiguration
      | ProxyHandler<SortConfiguration> = workspace
      .getConfiguration(EXTENSION_CONFIGURATION_NAME)
      .get<SortConfiguration>("sortConfiguration");
    const sortConfig = cloneDeep(sortConfigProxy);

    const importStringConfigProxy:
      | ImportStringConfiguration
      | ProxyHandler<ImportStringConfiguration> = workspace
      .getConfiguration(EXTENSION_CONFIGURATION_NAME)
      .get<ImportStringConfiguration>("importStringConfiguration");
    const importStringConfig = cloneDeep(importStringConfigProxy);

    const sortConfiguration = merge(
      sortConfig,
      fileConfig.sortConfiguration || {}
    );
    const importStringConfiguration = merge(
      importStringConfig,
      fileConfig.importStringConfiguration || {}
    );
    const generalConfiguration = merge(
      generalConfig,
      fileConfig.generalConfiguration || {}
    );
    return {
      sortConfiguration,
      importStringConfiguration,
      generalConfiguration,
    };
  }
}

export class ImportSorterExtension {
  private importRunner: ImportRunner;
  private configurationProvider: VSCodeConfigurationProvider;
  public initialise() {
    this.configurationProvider = new VSCodeConfigurationProvider();
    this.importRunner = new SimpleImportRunner(
      new SimpleImportAstParser(),
      new InMemoryImportSorter(),
      new InMemoryImportCreator(),
      this.configurationProvider
    );
  }

  public dispose() {
    return;
  }

  public sortActiveDocumentImportsFromCommand(): void {
    const textDoc = workspace.textDocuments.find(
      (d) => d.uri === workspace.uri
    );
    if (!this.isSortAllowed(textDoc, false)) {
      return;
    }
    this.configurationProvider.resetConfiguration();
    return this.sortActiveDocumentImports();
  }

  public sortImportsInDirectories(uri: Uri): Thenable<void> {
    this.configurationProvider.resetConfiguration();
    const sortImports$ = this.importRunner.sortImportsInDirectory(uri.fsPath);
    const statusItem = workspace.createStatusBarItem(1);
    statusItem.text = "Import sorter: sorting...";
    statusItem.isProgress = true;
    statusItem.show();
    return (sortImports$
      .pipe(
        mapObservable((_) => 1),
        scan((acc, curr) => acc + curr, 0),
        mapObservable(
          (fileCount) => (statusItem.text = `${fileCount} - sorted`)
        ),
        delay(1000)
      )
      .toPromise() as any) as Promise<void>;
  }

  public sortModifiedDocumentImportsFromOnBeforeSaveCommand(
    event: TextDocumentWillSaveEvent
  ): void {
    this.configurationProvider.resetConfiguration();
    const configuration = this.configurationProvider.getConfiguration();
    const isSortOnBeforeSaveEnabled =
      configuration.generalConfiguration.sortOnBeforeSave;
    if (!isSortOnBeforeSaveEnabled) {
      return;
    }
    if (!this.isSortAllowed(event.document, true)) {
      return;
    }
    return this.sortActiveDocumentImports(event);
  }

  private sortActiveDocumentImports(event?: TextDocumentWillSaveEvent): void {
    try {
      const doc: TextDocument = event
        ? event.document
        : workspace.textDocuments.find((d) => d.uri === workspace.uri);
      const text = doc.getText();
      const importData = this.importRunner.getSortImportData(doc.uri, text);
      if (!importData.isSortRequired) {
        return;
      }

      const deleteEdits = importData.rangesToDelete.map((x) =>
        TextEdit.del({
          start: { line: x.startLine, character: x.startCharacter },
          end: { line: x.endLine, character: x.endCharacter },
        })
      );

      if (event) {
        const insertEdit = TextEdit.insert(
          { line: importData.firstLineNumberToInsertText, character: 0 },
          importData.sortedImportsText + "\n"
        );
        event.waitUntil(Promise.resolve([...deleteEdits, insertEdit]));
      } else {
        workspace.getCurrentState().then((value) => value.document.uri);
        workspace.document.then((doc) =>
          doc.applyEdits([
            ...deleteEdits,
            TextEdit.insert(
              { line: importData.firstLineNumberToInsertText, character: 0 },
              importData.sortedImportsText + "\n"
            ),
          ])
        );
      }
    } catch (error) {
      const item = workspace.createStatusBarItem();
      item.text = `Typescript import sorter failed with - ${error.message}. Please log a bug.`;
      item.show();
    }
  }

  private isSortAllowed(
    document: TextDocument,
    isFileExtensionErrorIgnored: boolean
  ): boolean {
    if (!document) {
      return false;
    }

    if (
      document.languageId === "typescript" ||
      document.languageId === "typescriptreact"
    ) {
      return true;
    }

    if (isFileExtensionErrorIgnored) {
      return false;
    }
    const item = workspace.createStatusBarItem();
    item.text =
      "Import Sorter currently only supports typescript (.ts) or typescriptreact (.tsx) language files";
    item.show();
    return false;
  }
}
