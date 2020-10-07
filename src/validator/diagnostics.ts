import * as vscode from 'vscode';
import { Mutex } from 'await-semaphore';
import { CancellationToken } from './cancellationToken';
import { ValidatorCodeActionProvider } from "./ValidatorCodeActionProvider";
import { getValidatorMode, setValidatorMode, ValidatorMode } from './ValidatorMode';
import { getValidatorDiagnostics, Range, ValidatorDiagnostic, getCompilerDiagnostics, getValidExtensions, getValidLanguages, Completion } from './ValidatorClient';

const VALIDATOR_TOGGLE = "TabNine::validatorModeToggle";
const PASTE = "TabNine::paste";
export const TABNINE_DIAGNOSTIC_CODE = 'TabNine';

const BACKGROUND_THRESHOLD = 1;//65;
const PASTE_THRESHOLD = 1;
const EDIT_DISTANCE = 2;

export class TabNineDiagnostic extends vscode.Diagnostic {
    choices: Completion[] = [];
    reference: string;
    references: vscode.Range[] = [];
    validatorRange: Range;

    constructor(range: vscode.Range, message: string, choices: Completion[], reference: string, vscodeReferencesRange: vscode.Range[] , validatorRange: Range, severity?: vscode.DiagnosticSeverity) {
        super(range, message, severity);
        this.choices = choices;
        this.reference = reference;
        this.references = vscodeReferencesRange;
        this.validatorRange = validatorRange;
    }
}

const decorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: "RGBA(140, 198, 255, 0.25)",
    overviewRulerColor: "rgba(140, 198, 255, 1)",
    border: "1px solid RGBA(140, 198, 255, 1)",
    borderSpacing: "2px",
    borderRadius: "3px",
});


function setDecorators(diagnostics: vscode.Diagnostic[]) {
    let editor = vscode.window.activeTextEditor;
    if (editor) {
        let decorationsArray: vscode.DecorationOptions[] = [];
        diagnostics.forEach(d => {
            let t = diagnostics;
            let decoration = {
                range: d.range
            };
            decorationsArray.push(decoration);
        });
        editor.setDecorations(decorationType, decorationsArray);
    }
}

function setStatusBarMessage(message: string, timeout: number = 30000) {
    new Promise<vscode.Disposable>(resolve => {
        const disposable = vscode.window.setStatusBarMessage(message);
        setTimeout(() => resolve(disposable), timeout);
    }).then(disposable => disposable.dispose());
}

const mutex: Mutex = new Mutex();
const cancellationToken = new CancellationToken();

async function refreshDiagnostics(document: vscode.TextDocument, tabNineDiagnostics: vscode.DiagnosticCollection, visibleRanges: vscode.Range[]) {
    cancellationToken.cancel();
    const release = await mutex.acquire();
    cancellationToken.reset();
    try {
        let total = 0;
        let foundDiags = 0;
        const startTime = Date.now();
        const visibleRange = visibleRanges.reduce((accumulator, currentValue) => accumulator.union(currentValue));
        const start = document.offsetAt(visibleRange.start);
        const end = document.offsetAt(visibleRange.end);
        const threshold = getValidatorMode() == ValidatorMode.Background ? BACKGROUND_THRESHOLD : PASTE_THRESHOLD;
        const code = document.getText();
        setStatusBarMessage("TabNine Validator is working");
        const validatorDiagnostics: ValidatorDiagnostic[] = await getValidatorDiagnostics(code, document.fileName, {start: start, end: end}, threshold, EDIT_DISTANCE, cancellationToken);
        if (cancellationToken.isCancelled()) {
            setStatusBarMessage("");
            return [];
        }
        if (validatorDiagnostics === null) {
            setStatusBarMessage("TabNine Validator: error");
            return [];
        }
        const newTabNineDiagnostics: TabNineDiagnostic[] = [];
        validatorDiagnostics.forEach(validatorDiagnostic => {
            if (cancellationToken.isCancelled()) {
                setStatusBarMessage("");
                return [];
            }
            total++;
            let choices = validatorDiagnostic.completionList.filter(completion =>
                completion.value !== state.reference
            );
            let choicesString = choices.map(completion => {
                return `${completion.value}\t${completion.score}%`;
            });
            if (choices.length > 0) {

                let prevReferencesLocationsInRange = validatorDiagnostic.references.filter(r => r.start < validatorDiagnostic.range.start);
                let prevDiagnosticsForReferenceInRange = newTabNineDiagnostics.filter(diag => prevReferencesLocationsInRange.includes(diag.validatorRange));
                
                // If we are in paste mode and one of the previouse reference was ok (no suggestions), don't suggest things on this reference.
                if (getValidatorMode() == ValidatorMode.Background || 
                prevReferencesLocationsInRange.length == 0 || // no references before this point
                (prevReferencesLocationsInRange.length > 0 && prevDiagnosticsForReferenceInRange.length > 0)) { // there are references before this point. and we have diagnostics for them
                    const vscodeRange = new vscode.Range(document.positionAt(validatorDiagnostic.range.start), document.positionAt(validatorDiagnostic.range.end));
                    const vscodeReferencesRange: vscode.Range[] = validatorDiagnostic.references.map(r => new vscode.Range(document.positionAt(r.start), document.positionAt(r.end)))
                    let diagnostic = new TabNineDiagnostic(vscodeRange, "Did you mean:\n" + choicesString.join("\n") + " ",
                        choices, validatorDiagnostic.reference, vscodeReferencesRange, validatorDiagnostic.range, vscode.DiagnosticSeverity.Information);
                    diagnostic.code = TABNINE_DIAGNOSTIC_CODE;
                    newTabNineDiagnostics.push(diagnostic);
                    foundDiags++;
                }
            }
        });
        setDecorators(newTabNineDiagnostics);
        tabNineDiagnostics.set(document.uri, newTabNineDiagnostics);
        let elpased = Date.now() - startTime;
        const message = `TabNine Validator ended in ${Math.floor(elpased / 1000)} seconds (found ${foundDiags} suspicious location(s) out of ${total})`
        console.log(message);
        setStatusBarMessage(message);
        return newTabNineDiagnostics;
    } catch (e) {
        return [];
    } finally {
        release();
    }
}

function getNanoSecTime() {
    var hrTime = process.hrtime();
    return hrTime[0] * 1000000000 + hrTime[1];
}

let state: any = {};
async function refreshDiagnosticsWrapper(document, diagnostics, ranges, sleep = 500) {
    const timestamp = getNanoSecTime();
    state = {
        "document": document,
        "diagnostics": diagnostics,
        "ranges": ranges,
        "timestamp": timestamp
    };
    await new Promise(resolve => setTimeout(resolve, sleep));
    if (state.timestamp === timestamp) {
        refreshDiagnostics(state.document, state.diagnostics, state.ranges);
    }
}

export async function registerValidator(context: vscode.ExtensionContext): Promise<void> {
    const tabNineDiagnostics = vscode.languages.createDiagnosticCollection("tabNine");
    context.subscriptions.push(tabNineDiagnostics);

    vscode.commands.registerTextEditorCommand(VALIDATOR_TOGGLE, async () => {
        cancellationToken.cancel();
        tabNineDiagnostics.delete(vscode.window.activeTextEditor.document.uri);
        setDecorators([]);
        const newMode = getValidatorMode() == ValidatorMode.Background ? ValidatorMode.Paste : ValidatorMode.Background;
        setValidatorMode(newMode);
        if (getValidatorMode() == ValidatorMode.Paste) {
            vscode.window.showInformationMessage("TabNine Paste validation mode");
            console.log("Paste validation mode");
        } else {
            refreshDiagnostics(vscode.window.activeTextEditor.document, tabNineDiagnostics, vscode.window.activeTextEditor.visibleRanges);
            vscode.window.showInformationMessage("TabNine Background validation mode");
            console.log("Background validation mode");
        }
    });

    const validLanguages = await getValidLanguages();
    const validExtensions = await getValidExtensions();

    if (vscode.window.activeTextEditor && validLanguages.includes(vscode.window.activeTextEditor.document.languageId)) {
        const document = vscode.window.activeTextEditor.document;
        if (getValidatorMode() == ValidatorMode.Background) {
            refreshDiagnostics(document, tabNineDiagnostics, vscode.window.activeTextEditor.visibleRanges);
        } else { // prefetch diagnostics (getValidatorMode() == Mode.Paste)
            console.log("prefetching diagnostics for " + document.fileName);
            getCompilerDiagnostics(document.getText(), document.fileName);
        }

    }

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async editor => {
            if (editor && validLanguages.includes(editor.document.languageId)) {
                if (getValidatorMode() == ValidatorMode.Background) {
                    refreshDiagnostics(editor.document, tabNineDiagnostics, editor.visibleRanges);
                } else { // prefetch diagnostics 
                    console.log("prefetching diagnostics for " + editor.document.fileName);
                    getCompilerDiagnostics(editor.document.getText(), editor.document.fileName);
                }
            }
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorVisibleRanges(async event => {
            if (getValidatorMode() == ValidatorMode.Background) {
                refreshDiagnosticsWrapper(event.textEditor.document, tabNineDiagnostics, event.textEditor.visibleRanges);
            }
        })
    );

    let currentRange: { range: vscode.Range, length: number } = null;
    let inPaste = false;
    context.subscriptions.push(
        vscode.commands.registerTextEditorCommand(PASTE, async (textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, args: any[]) => {
            inPaste = true;
            let start = textEditor.selection.start;
            await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
            let end = textEditor.selection.end;
            let document = vscode.window.activeTextEditor.document;
            let fileName = document.fileName;
            let fileExt = "." + fileName.split('.').pop();
            let isValidExt = validExtensions.includes(fileExt);
            if (!isValidExt || getValidatorMode() == ValidatorMode.Background) {
                inPaste = false;
                return;
            }
            currentRange = {
                range: new vscode.Range(start, end),
                length: document.offsetAt(end) - document.offsetAt(start)
            };
            inPaste = false;
            tabNineDiagnostics.delete(document.uri);
            setDecorators([]);
            refreshDiagnostics(document, tabNineDiagnostics, [currentRange.range]);
        })
    );

    // For ValidatorMode.Paste
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(async event => {
            if (validLanguages.includes(event.document.languageId) && getValidatorMode() == ValidatorMode.Paste && !inPaste) {

                let firstPosition: vscode.Position = null;
                let delta = 0;
                event.contentChanges.forEach(cc => {
                    if (firstPosition === null) {
                        firstPosition = cc.range.start;
                    } else if (cc.range.start.isBefore(firstPosition)) {
                        firstPosition = cc.range.start;
                    }
                    if (currentRange !== null) {
                        if (cc.range.start.isAfterOrEqual(currentRange.range.start) && cc.range.end.isBeforeOrEqual(currentRange.range.end)) {
                            delta += (-cc.rangeLength) + (cc.text.length || 0);
                        } else {
                            currentRange = null;
                        }
                    }
                });
                if (firstPosition !== null) {
                    let diagnostics = tabNineDiagnostics.get(event.document.uri).filter(d =>
                        d.range.end.isBefore(firstPosition)
                    );
                    tabNineDiagnostics.set(event.document.uri, diagnostics);
                    setDecorators(diagnostics);
                    if (currentRange !== null && delta !== 0) {
                        let newLength = currentRange.length + delta;
                        let newEndPos = event.document.positionAt(event.document.offsetAt(currentRange.range.start) + newLength);
                        currentRange = {
                            range: new vscode.Range(currentRange.range.start, newEndPos),
                            length: newLength
                        };
                        refreshDiagnosticsWrapper(event.document, tabNineDiagnostics, [currentRange.range]);
                    }
                } else {
                    tabNineDiagnostics.delete(event.document.uri);
                    setDecorators([]);
                }
            }
        })
    );

    // For ValidatorMode.Background
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(async event => {
            if (validLanguages.includes(event.document.languageId) && getValidatorMode() == ValidatorMode.Background) {
                let firstPoition: vscode.Position = null;
                event.contentChanges.forEach(cc => {
                    if (firstPoition === null) {
                        firstPoition = cc.range.start;
                    } else if (cc.range.start.isBefore(firstPoition)) {
                        firstPoition = cc.range.start;
                    }
                });
                if (firstPoition !== null) {
                    let diagnostics = tabNineDiagnostics.get(event.document.uri).filter(d =>
                        d.range.end.isBefore(firstPoition)
                    );
                    tabNineDiagnostics.set(event.document.uri, diagnostics);
                    setDecorators(diagnostics);
                } else {
                    tabNineDiagnostics.delete(event.document.uri);
                    setDecorators([]);
                }
                refreshDiagnosticsWrapper(vscode.window.activeTextEditor.document, tabNineDiagnostics, vscode.window.activeTextEditor.visibleRanges);
            }
        })
    );
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(validLanguages, new ValidatorCodeActionProvider(), {
            providedCodeActionKinds: ValidatorCodeActionProvider.providedCodeActionKinds
        })
    );

}
