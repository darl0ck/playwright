/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as fs from 'fs';
import * as mime from 'mime';
import * as path from 'path';
import * as util from 'util';
import * as frames from './frames';
import { assert, helper, assertMaxArguments } from './helper';
import InjectedScript from './injected/injectedScript';
import * as injectedScriptSource from './generated/injectedScriptSource';
import * as debugScriptSource from './generated/debugScriptSource';
import * as js from './javascript';
import { Page } from './page';
import { selectors, SelectorInfo } from './selectors';
import * as types from './types';
import { Progress } from './progress';
import DebugScript from './debug/injected/debugScript';
import { FatalDOMError, RetargetableDOMError } from './common/domErrors';

export class FrameExecutionContext extends js.ExecutionContext {
  readonly frame: frames.Frame;
  private _injectedScriptPromise?: Promise<js.JSHandle>;
  private _debugScriptPromise?: Promise<js.JSHandle | undefined>;

  constructor(delegate: js.ExecutionContextDelegate, frame: frames.Frame) {
    super(delegate);
    this.frame = frame;
  }

  adoptIfNeeded(handle: js.JSHandle): Promise<js.JSHandle> | null {
    if (handle instanceof ElementHandle && handle._context !== this)
      return this.frame._page._delegate.adoptElementHandle(handle, this);
    return null;
  }

  async evaluateInternal<R>(pageFunction: js.Func0<R>): Promise<R>;
  async evaluateInternal<Arg, R>(pageFunction: js.Func1<Arg, R>, arg: Arg): Promise<R>;
  async evaluateInternal(pageFunction: never, ...args: never[]): Promise<any> {
    return await this.frame._page._frameManager.waitForSignalsCreatedBy(null, false /* noWaitFor */, async () => {
      return js.evaluate(this, true /* returnByValue */, pageFunction, ...args);
    });
  }

  async evaluateExpressionInternal(expression: string, isFunction: boolean, ...args: any[]): Promise<any> {
    return await this.frame._page._frameManager.waitForSignalsCreatedBy(null, false /* noWaitFor */, async () => {
      return js.evaluateExpression(this, true /* returnByValue */, expression, isFunction, ...args);
    });
  }

  async evaluateHandleInternal<R>(pageFunction: js.Func0<R>): Promise<js.SmartHandle<R>>;
  async evaluateHandleInternal<Arg, R>(pageFunction: js.Func1<Arg, R>, arg: Arg): Promise<js.SmartHandle<R>>;
  async evaluateHandleInternal(pageFunction: never, ...args: never[]): Promise<any> {
    return await this.frame._page._frameManager.waitForSignalsCreatedBy(null, false /* noWaitFor */, async () => {
      return js.evaluate(this, false /* returnByValue */, pageFunction, ...args);
    });
  }

  async evaluateExpressionHandleInternal(expression: string, isFunction: boolean, ...args: any[]): Promise<any> {
    return await this.frame._page._frameManager.waitForSignalsCreatedBy(null, false /* noWaitFor */, async () => {
      return js.evaluateExpression(this, false /* returnByValue */, expression, isFunction, ...args);
    });
  }

  createHandle(remoteObject: js.RemoteObject): js.JSHandle {
    if (this.frame._page._delegate.isElementHandle(remoteObject))
      return new ElementHandle(this, remoteObject.objectId!);
    return super.createHandle(remoteObject);
  }

  injectedScript(): Promise<js.JSHandle<InjectedScript>> {
    if (!this._injectedScriptPromise) {
      const custom: string[] = [];
      for (const [name, { source }] of selectors._engines)
        custom.push(`{ name: '${name}', engine: (${source}) }`);
      const source = `
        new (${injectedScriptSource.source})([
          ${custom.join(',\n')}
        ])
      `;
      this._injectedScriptPromise = this._delegate.rawEvaluate(source).then(objectId => new js.JSHandle(this, 'object', objectId));
    }
    return this._injectedScriptPromise;
  }

  createDebugScript(options: { record?: boolean, console?: boolean }): Promise<js.JSHandle<DebugScript> | undefined> {
    if (!this._debugScriptPromise) {
      const source = `new (${debugScriptSource.source})()`;
      this._debugScriptPromise = this._delegate.rawEvaluate(source).then(objectId => new js.JSHandle(this, 'object', objectId)).then(async debugScript => {
        const injectedScript = await this.injectedScript();
        await debugScript.evaluate((debugScript: DebugScript, { injectedScript, options }) => debugScript.initialize(injectedScript, options), { injectedScript, options });
        return debugScript;
      }).catch(e => undefined);
    }
    return this._debugScriptPromise;
  }
}

export class ElementHandle<T extends Node = Node> extends js.JSHandle<T> {
  readonly _context: FrameExecutionContext;
  readonly _page: Page;
  readonly _objectId: string;

  constructor(context: FrameExecutionContext, objectId: string) {
    super(context, 'node', objectId);
    this._objectId = objectId;
    this._context = context;
    this._page = context.frame._page;
    this._initializePreview().catch(e => {});
  }

  async _initializePreview() {
    const utility = await this._context.injectedScript();
    this._preview = await utility.evaluate((injected, e) => 'JSHandle@' + injected.previewNode(e), this);
  }

  asElement(): ElementHandle<T> | null {
    return this;
  }

  async _evaluateInMain<R, Arg>(pageFunction: js.Func1<[js.JSHandle<InjectedScript>, ElementHandle<T>, Arg], R>, arg: Arg): Promise<R> {
    const main = await this._context.frame._mainContext();
    return main.evaluateInternal(pageFunction, [await main.injectedScript(), this, arg]);
  }

  async _evaluateInUtility<R, Arg>(pageFunction: js.Func1<[js.JSHandle<InjectedScript>, ElementHandle<T>, Arg], R>, arg: Arg): Promise<R> {
    const utility = await this._context.frame._utilityContext();
    return utility.evaluateInternal(pageFunction, [await utility.injectedScript(), this, arg]);
  }

  async _evaluateHandleInUtility<R, Arg>(pageFunction: js.Func1<[js.JSHandle<InjectedScript>, ElementHandle<T>, Arg], R>, arg: Arg): Promise<js.JSHandle<R>> {
    const utility = await this._context.frame._utilityContext();
    return utility.evaluateHandleInternal(pageFunction, [await utility.injectedScript(), this, arg]);
  }

  async ownerFrame(): Promise<frames.Frame | null> {
    const frameId = await this._page._delegate.getOwnerFrame(this);
    if (!frameId)
      return null;
    const frame = this._page._frameManager.frame(frameId);
    if (frame)
      return frame;
    for (const page of this._page._browserContext.pages()) {
      const frame = page._frameManager.frame(frameId);
      if (frame)
        return frame;
    }
    return null;
  }

  async contentFrame(): Promise<frames.Frame | null> {
    const isFrameElement = await this._evaluateInUtility(([injected, node]) => node && (node.nodeName === 'IFRAME' || node.nodeName === 'FRAME'), {});
    if (!isFrameElement)
      return null;
    return this._page._delegate.getContentFrame(this);
  }

  async getAttribute(name: string): Promise<string | null> {
    return throwFatalDOMError(await this._evaluateInUtility(([injeced, node, name]) => {
      if (node.nodeType !== Node.ELEMENT_NODE)
        return 'error:notelement';
      const element = node as unknown as Element;
      return { value: element.getAttribute(name) };
    }, name)).value;
  }

  async textContent(): Promise<string | null> {
    return this._evaluateInUtility(([injected, node]) => node.textContent, {});
  }

  async innerText(): Promise<string> {
    return throwFatalDOMError(await this._evaluateInUtility(([injected, node]) => {
      if (node.nodeType !== Node.ELEMENT_NODE)
        return 'error:notelement';
      if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml')
        return 'error:nothtmlelement';
      const element = node as unknown as HTMLElement;
      return { value: element.innerText };
    }, {})).value;
  }

  async innerHTML(): Promise<string> {
    return throwFatalDOMError(await this._evaluateInUtility(([injected, node]) => {
      if (node.nodeType !== Node.ELEMENT_NODE)
        return 'error:notelement';
      const element = node as unknown as Element;
      return { value: element.innerHTML };
    }, {})).value;
  }

  async dispatchEvent(type: string, eventInit: Object = {}) {
    await this._evaluateInMain(([injected, node, { type, eventInit }]) =>
      injected.dispatchEvent(node, type, eventInit), { type, eventInit });
  }

  async _scrollRectIntoViewIfNeeded(rect?: types.Rect): Promise<'error:notvisible' | 'error:notconnected' | 'done'> {
    return await this._page._delegate.scrollRectIntoViewIfNeeded(this, rect);
  }

  async _waitAndScrollIntoViewIfNeeded(progress: Progress): Promise<void> {
    while (progress.isRunning()) {
      assertDone(throwRetargetableDOMError(await this._waitForVisible(progress)));

      progress.throwIfAborted();  // Avoid action that has side-effects.
      const result = throwRetargetableDOMError(await this._scrollRectIntoViewIfNeeded());
      if (result === 'error:notvisible')
        continue;
      assertDone(result);
      return;
    }
  }

  async scrollIntoViewIfNeeded(options: types.TimeoutOptions = {}) {
    return this._page._runAbortableTask(
        progress => this._waitAndScrollIntoViewIfNeeded(progress),
        this._page._timeoutSettings.timeout(options), 'elementHandle.scrollIntoViewIfNeeded');
  }

  private async _waitForVisible(progress: Progress): Promise<'error:notconnected' | 'done'> {
    const poll = await this._evaluateHandleInUtility(([injected, node]) => {
      return injected.waitForNodeVisible(node);
    }, {});
    const pollHandler = new InjectedScriptPollHandler(progress, poll);
    return throwFatalDOMError(await pollHandler.finish());
  }

  private async _clickablePoint(): Promise<types.Point | 'error:notvisible' | 'error:notinviewport'> {
    const intersectQuadWithViewport = (quad: types.Quad): types.Quad => {
      return quad.map(point => ({
        x: Math.min(Math.max(point.x, 0), metrics.width),
        y: Math.min(Math.max(point.y, 0), metrics.height),
      })) as types.Quad;
    };

    const computeQuadArea = (quad: types.Quad) => {
      // Compute sum of all directed areas of adjacent triangles
      // https://en.wikipedia.org/wiki/Polygon#Simple_polygons
      let area = 0;
      for (let i = 0; i < quad.length; ++i) {
        const p1 = quad[i];
        const p2 = quad[(i + 1) % quad.length];
        area += (p1.x * p2.y - p2.x * p1.y) / 2;
      }
      return Math.abs(area);
    };

    const [quads, metrics] = await Promise.all([
      this._page._delegate.getContentQuads(this),
      this._page.mainFrame()._utilityContext().then(utility => utility.evaluateInternal(() => ({width: innerWidth, height: innerHeight}))),
    ] as const);
    if (!quads || !quads.length)
      return 'error:notvisible';

    const filtered = quads.map(quad => intersectQuadWithViewport(quad)).filter(quad => computeQuadArea(quad) > 1);
    if (!filtered.length)
      return 'error:notinviewport';
    // Return the middle point of the first quad.
    const result = { x: 0, y: 0 };
    for (const point of filtered[0]) {
      result.x += point.x / 4;
      result.y += point.y / 4;
    }
    return result;
  }

  private async _offsetPoint(offset: types.Point): Promise<types.Point | 'error:notvisible'> {
    const [box, border] = await Promise.all([
      this.boundingBox(),
      this._evaluateInUtility(([injected, node]) => injected.getElementBorderWidth(node), {}).catch(e => {}),
    ]);
    if (!box || !border)
      return 'error:notvisible';
    // Make point relative to the padding box to align with offsetX/offsetY.
    return {
      x: box.x + border.left + offset.x,
      y: box.y + border.top + offset.y,
    };
  }

  async _retryPointerAction(progress: Progress, action: (point: types.Point) => Promise<void>, options: types.PointerActionOptions & types.PointerActionWaitOptions & types.NavigatingActionWaitOptions): Promise<'error:notconnected' | 'done'> {
    let first = true;
    while (progress.isRunning()) {
      progress.logger.info(`${first ? 'attempting' : 'retrying'} ${progress.apiName} action`);
      const result = await this._performPointerAction(progress, action, options);
      first = false;
      if (result === 'error:notvisible') {
        if (options.force)
          throw new Error('Element is not visible');
        progress.logger.info('  element is not visible');
        continue;
      }
      if (result === 'error:notinviewport') {
        if (options.force)
          throw new Error('Element is outside of the viewport');
        progress.logger.info('  element is outside of the viewport');
        continue;
      }
      if (result === 'error:nothittarget') {
        if (options.force)
          throw new Error('Element does not receive pointer events');
        progress.logger.info('  element does not receive pointer events');
        continue;
      }
      return result;
    }
    return 'done';
  }

  async _performPointerAction(progress: Progress, action: (point: types.Point) => Promise<void>, options: types.PointerActionOptions & types.PointerActionWaitOptions & types.NavigatingActionWaitOptions): Promise<'error:notvisible' | 'error:notconnected' | 'error:notinviewport' | 'error:nothittarget' | 'done'> {
    const { force = false, position } = options;
    if ((options as any).__testHookBeforeStable)
      await (options as any).__testHookBeforeStable();
    if (!force) {
      const result = await this._waitForDisplayedAtStablePositionAndEnabled(progress);
      if (result !== 'done')
        return result;
    }
    if ((options as any).__testHookAfterStable)
      await (options as any).__testHookAfterStable();

    progress.logger.info('  scrolling into view if needed');
    progress.throwIfAborted();  // Avoid action that has side-effects.
    const scrolled = await this._scrollRectIntoViewIfNeeded(position ? { x: position.x, y: position.y, width: 0, height: 0 } : undefined);
    if (scrolled !== 'done')
      return scrolled;
    progress.logger.info('  done scrolling');

    const maybePoint = position ? await this._offsetPoint(position) : await this._clickablePoint();
    if (typeof maybePoint === 'string')
      return maybePoint;
    const point = roundPoint(maybePoint);

    if (!force) {
      if ((options as any).__testHookBeforeHitTarget)
        await (options as any).__testHookBeforeHitTarget();
      progress.logger.info(`  checking that element receives pointer events at (${point.x},${point.y})`);
      const hitTargetResult = await this._checkHitTargetAt(point);
      if (hitTargetResult !== 'done')
        return hitTargetResult;
      progress.logger.info(`  element does receive pointer events`);
    }

    await this._page._frameManager.waitForSignalsCreatedBy(progress, options.noWaitAfter, async () => {
      if ((options as any).__testHookBeforePointerAction)
        await (options as any).__testHookBeforePointerAction();
      progress.throwIfAborted();  // Avoid action that has side-effects.
      let restoreModifiers: types.KeyboardModifier[] | undefined;
      if (options && options.modifiers)
        restoreModifiers = await this._page.keyboard._ensureModifiers(options.modifiers);
      progress.logger.info(`  performing ${progress.apiName} action`);
      await action(point);
      progress.logger.info(`  ${progress.apiName} action done`);
      progress.logger.info('  waiting for scheduled navigations to finish');
      if ((options as any).__testHookAfterPointerAction)
        await (options as any).__testHookAfterPointerAction();
      if (restoreModifiers)
        await this._page.keyboard._ensureModifiers(restoreModifiers);
    }, 'input');
    progress.logger.info('  navigations have finished');

    return 'done';
  }

  hover(options: types.PointerActionOptions & types.PointerActionWaitOptions = {}): Promise<void> {
    return this._page._runAbortableTask(async progress => {
      const result = await this._hover(progress, options);
      return assertDone(throwRetargetableDOMError(result));
    }, this._page._timeoutSettings.timeout(options), 'elementHandle.hover');
  }

  _hover(progress: Progress, options: types.PointerActionOptions & types.PointerActionWaitOptions): Promise<'error:notconnected' | 'done'> {
    return this._retryPointerAction(progress, point => this._page.mouse.move(point.x, point.y), options);
  }

  click(options: types.MouseClickOptions & types.PointerActionWaitOptions & types.NavigatingActionWaitOptions = {}): Promise<void> {
    return this._page._runAbortableTask(async progress => {
      const result = await this._click(progress, options);
      return assertDone(throwRetargetableDOMError(result));
    }, this._page._timeoutSettings.timeout(options), 'elementHandle.click');
  }

  _click(progress: Progress, options: types.MouseClickOptions & types.PointerActionWaitOptions & types.NavigatingActionWaitOptions): Promise<'error:notconnected' | 'done'> {
    return this._retryPointerAction(progress, point => this._page.mouse.click(point.x, point.y, options), options);
  }

  dblclick(options: types.MouseMultiClickOptions & types.PointerActionWaitOptions & types.NavigatingActionWaitOptions = {}): Promise<void> {
    return this._page._runAbortableTask(async progress => {
      const result = await this._dblclick(progress, options);
      return assertDone(throwRetargetableDOMError(result));
    }, this._page._timeoutSettings.timeout(options), 'elementHandle.dblclick');
  }

  _dblclick(progress: Progress, options: types.MouseMultiClickOptions & types.PointerActionWaitOptions & types.NavigatingActionWaitOptions): Promise<'error:notconnected' | 'done'> {
    return this._retryPointerAction(progress, point => this._page.mouse.dblclick(point.x, point.y, options), options);
  }

  async selectOption(values: string | ElementHandle | types.SelectOption | string[] | ElementHandle[] | types.SelectOption[] | null, options: types.NavigatingActionWaitOptions = {}): Promise<string[]> {
    return this._page._runAbortableTask(async progress => {
      const result = await this._selectOption(progress, values, options);
      return throwRetargetableDOMError(result);
    }, this._page._timeoutSettings.timeout(options), 'elementHandle.selectOption');
  }

  async _selectOption(progress: Progress, values: string | ElementHandle | types.SelectOption | string[] | ElementHandle[] | types.SelectOption[] | null, options: types.NavigatingActionWaitOptions): Promise<string[] | 'error:notconnected'> {
    let vals: string[] | ElementHandle[] | types.SelectOption[];
    if (values === null)
      vals = [];
    else if (!Array.isArray(values))
      vals = [ values ] as (string[] | ElementHandle[] | types.SelectOption[]);
    else
      vals = values;
    const selectOptions = (vals as any).map((value: any) => typeof value === 'object' ? value : { value });
    for (const option of selectOptions) {
      assert(option !== null, 'Value items must not be null');
      if (option instanceof ElementHandle)
        continue;
      if (option.value !== undefined)
        assert(helper.isString(option.value), 'Values must be strings. Found value "' + option.value + '" of type "' + (typeof option.value) + '"');
      if (option.label !== undefined)
        assert(helper.isString(option.label), 'Labels must be strings. Found label "' + option.label + '" of type "' + (typeof option.label) + '"');
      if (option.index !== undefined)
        assert(helper.isNumber(option.index), 'Indices must be numbers. Found index "' + option.index + '" of type "' + (typeof option.index) + '"');
    }
    return this._page._frameManager.waitForSignalsCreatedBy(progress, options.noWaitAfter, async () => {
      progress.throwIfAborted();  // Avoid action that has side-effects.
      return throwFatalDOMError(await this._evaluateInUtility(([injected, node, selectOptions]) => injected.selectOptions(node, selectOptions), selectOptions));
    });
  }

  async fill(value: string, options: types.NavigatingActionWaitOptions = {}): Promise<void> {
    return this._page._runAbortableTask(async progress => {
      const result = await this._fill(progress, value, options);
      assertDone(throwRetargetableDOMError(result));
    }, this._page._timeoutSettings.timeout(options), 'elementHandle.fill');
  }

  async _fill(progress: Progress, value: string, options: types.NavigatingActionWaitOptions): Promise<'error:notconnected' | 'done'> {
    progress.logger.info(`elementHandle.fill("${value}")`);
    assert(helper.isString(value), 'Value must be string. Found value "' + value + '" of type "' + (typeof value) + '"');
    return this._page._frameManager.waitForSignalsCreatedBy(progress, options.noWaitAfter, async () => {
      progress.logger.info('  waiting for element to be visible, enabled and editable');
      const poll = await this._evaluateHandleInUtility(([injected, node, value]) => {
        return injected.waitForEnabledAndFill(node, value);
      }, value);
      const pollHandler = new InjectedScriptPollHandler(progress, poll);
      const filled = throwFatalDOMError(await pollHandler.finish());
      progress.throwIfAborted();  // Avoid action that has side-effects.
      if (filled === 'error:notconnected')
        return filled;
      progress.logger.info('  element is visible, enabled and editable');
      if (filled === 'needsinput') {
        progress.throwIfAborted();  // Avoid action that has side-effects.
        if (value)
          await this._page.keyboard.insertText(value);
        else
          await this._page.keyboard.press('Delete');
      } else {
        assertDone(filled);
      }
      return 'done';
    }, 'input');
  }

  async selectText(options: types.TimeoutOptions = {}): Promise<void> {
    return this._page._runAbortableTask(async progress => {
      progress.throwIfAborted();  // Avoid action that has side-effects.
      const poll = await this._evaluateHandleInUtility(([injected, node]) => {
        return injected.waitForVisibleAndSelectText(node);
      }, {});
      const pollHandler = new InjectedScriptPollHandler(progress, poll);
      const result = throwFatalDOMError(await pollHandler.finish());
      assertDone(throwRetargetableDOMError(result));
    }, this._page._timeoutSettings.timeout(options), 'elementHandle.selectText');
  }

  async setInputFiles(files: string | types.FilePayload | string[] | types.FilePayload[], options: types.NavigatingActionWaitOptions = {}) {
    return this._page._runAbortableTask(async progress => {
      const result = await this._setInputFiles(progress, files, options);
      return assertDone(throwRetargetableDOMError(result));
    }, this._page._timeoutSettings.timeout(options), 'elementHandle.setInputFiles');
  }

  async _setInputFiles(progress: Progress, files: string | types.FilePayload | string[] | types.FilePayload[], options: types.NavigatingActionWaitOptions): Promise<'error:notconnected' | 'done'> {
    const multiple = throwFatalDOMError(await this._evaluateInUtility(([injected, node]): 'error:notinput' | 'error:notconnected' | boolean => {
      if (node.nodeType !== Node.ELEMENT_NODE || (node as Node as Element).tagName !== 'INPUT')
        return 'error:notinput';
      if (!node.isConnected)
        return 'error:notconnected';
      const input = node as Node as HTMLInputElement;
      return input.multiple;
    }, {}));
    if (typeof multiple === 'string')
      return multiple;
    let ff: string[] | types.FilePayload[];
    if (!Array.isArray(files))
      ff = [ files ] as string[] | types.FilePayload[];
    else
      ff = files;
    assert(multiple || ff.length <= 1, 'Non-multiple file input can only accept single file!');
    const filePayloads: types.FilePayload[] = [];
    for (const item of ff) {
      if (typeof item === 'string') {
        const file: types.FilePayload = {
          name: path.basename(item),
          mimeType: mime.getType(item) || 'application/octet-stream',
          buffer: await util.promisify(fs.readFile)(item)
        };
        filePayloads.push(file);
      } else {
        filePayloads.push(item);
      }
    }
    await this._page._frameManager.waitForSignalsCreatedBy(progress, options.noWaitAfter, async () => {
      progress.throwIfAborted();  // Avoid action that has side-effects.
      await this._page._delegate.setInputFiles(this as any as ElementHandle<HTMLInputElement>, filePayloads);
    });
    return 'done';
  }

  async focus(): Promise<void> {
    return this._page._runAbortableTask(async progress => {
      const result = await this._focus(progress);
      return assertDone(throwRetargetableDOMError(result));
    }, 0, 'elementHandle.focus');
  }

  async _focus(progress: Progress): Promise<'error:notconnected' | 'done'> {
    progress.throwIfAborted();  // Avoid action that has side-effects.
    const result = await this._evaluateInUtility(([injected, node]) => injected.focusNode(node), {});
    return throwFatalDOMError(result);
  }

  async type(text: string, options: { delay?: number } & types.NavigatingActionWaitOptions = {}): Promise<void> {
    return this._page._runAbortableTask(async progress => {
      const result = await this._type(progress, text, options);
      return assertDone(throwRetargetableDOMError(result));
    }, this._page._timeoutSettings.timeout(options), 'elementHandle.type');
  }

  async _type(progress: Progress, text: string, options: { delay?: number } & types.NavigatingActionWaitOptions): Promise<'error:notconnected' | 'done'> {
    progress.logger.info(`elementHandle.type("${text}")`);
    return this._page._frameManager.waitForSignalsCreatedBy(progress, options.noWaitAfter, async () => {
      const result = await this._focus(progress);
      if (result !== 'done')
        return result;
      progress.throwIfAborted();  // Avoid action that has side-effects.
      await this._page.keyboard.type(text, options);
      return 'done';
    }, 'input');
  }

  async press(key: string, options: { delay?: number } & types.NavigatingActionWaitOptions = {}): Promise<void> {
    return this._page._runAbortableTask(async progress => {
      const result = await this._press(progress, key, options);
      return assertDone(throwRetargetableDOMError(result));
    }, this._page._timeoutSettings.timeout(options), 'elementHandle.press');
  }

  async _press(progress: Progress, key: string, options: { delay?: number } & types.NavigatingActionWaitOptions): Promise<'error:notconnected' | 'done'> {
    progress.logger.info(`elementHandle.press("${key}")`);
    return this._page._frameManager.waitForSignalsCreatedBy(progress, options.noWaitAfter, async () => {
      const result = await this._focus(progress);
      if (result !== 'done')
        return result;
      progress.throwIfAborted();  // Avoid action that has side-effects.
      await this._page.keyboard.press(key, options);
      return 'done';
    }, 'input');
  }

  async check(options: types.PointerActionWaitOptions & types.NavigatingActionWaitOptions = {}) {
    return this._page._runAbortableTask(async progress => {
      const result = await this._setChecked(progress, true, options);
      return assertDone(throwRetargetableDOMError(result));
    }, this._page._timeoutSettings.timeout(options), 'elementHandle.check');
  }

  async uncheck(options: types.PointerActionWaitOptions & types.NavigatingActionWaitOptions = {}) {
    return this._page._runAbortableTask(async progress => {
      const result = await this._setChecked(progress, false, options);
      return assertDone(throwRetargetableDOMError(result));
    }, this._page._timeoutSettings.timeout(options), 'elementHandle.uncheck');
  }

  async _setChecked(progress: Progress, state: boolean, options: types.PointerActionWaitOptions & types.NavigatingActionWaitOptions): Promise<'error:notconnected' | 'done'> {
    if (await this._evaluateInUtility(([injected, node]) => injected.isCheckboxChecked(node), {}) === state)
      return 'done';
    const result = await this._click(progress, options);
    if (result !== 'done')
      return result;
    if (await this._evaluateInUtility(([injected, node]) => injected.isCheckboxChecked(node), {}) !== state)
      throw new Error('Unable to click checkbox');
    return 'done';
  }

  async boundingBox(): Promise<types.Rect | null> {
    return this._page._delegate.getBoundingBox(this);
  }

  async screenshot(options: types.ElementScreenshotOptions = {}): Promise<Buffer> {
    return this._page._runAbortableTask(
        progress => this._page._screenshotter.screenshotElement(progress, this, options),
        this._page._timeoutSettings.timeout(options), 'elementHandle.screenshot');
  }

  async $(selector: string): Promise<ElementHandle | null> {
    return selectors._query(this._context.frame, selector, this);
  }

  async $$(selector: string): Promise<ElementHandle<Element>[]> {
    return selectors._queryAll(this._context.frame, selector, this);
  }

  async $eval<R, Arg>(selector: string, pageFunction: js.FuncOn<Element, Arg, R>, arg: Arg): Promise<R>;
  async $eval<R>(selector: string, pageFunction: js.FuncOn<Element, void, R>, arg?: any): Promise<R>;
  async $eval<R, Arg>(selector: string, pageFunction: js.FuncOn<Element, Arg, R>, arg: Arg): Promise<R> {
    assertMaxArguments(arguments.length, 3);
    return this._$evalExpression(selector, String(pageFunction), typeof pageFunction === 'function', arg);
  }

  async _$evalExpression(selector: string, expression: string, isFunction: boolean, arg: any): Promise<any> {
    const handle = await selectors._query(this._context.frame, selector, this);
    if (!handle)
      throw new Error(`Error: failed to find element matching selector "${selector}"`);
    const result = await handle._evaluateExpression(expression, isFunction, true, arg);
    handle.dispose();
    return result;
  }

  async $$eval<R, Arg>(selector: string, pageFunction: js.FuncOn<Element[], Arg, R>, arg: Arg): Promise<R>;
  async $$eval<R>(selector: string, pageFunction: js.FuncOn<Element[], void, R>, arg?: any): Promise<R>;
  async $$eval<R, Arg>(selector: string, pageFunction: js.FuncOn<Element[], Arg, R>, arg: Arg): Promise<R> {
    assertMaxArguments(arguments.length, 3);
    return this._$$evalExpression(selector, String(pageFunction), typeof pageFunction === 'function', arg);
  }

  async _$$evalExpression(selector: string, expression: string, isFunction: boolean, arg: any): Promise<any> {
    const arrayHandle = await selectors._queryArray(this._context.frame, selector, this);
    const result = await arrayHandle._evaluateExpression(expression, isFunction, true, arg);
    arrayHandle.dispose();
    return result;
  }

  async _waitForDisplayedAtStablePositionAndEnabled(progress: Progress): Promise<'error:notconnected' | 'done'> {
    progress.logger.info('  waiting for element to be visible, enabled and not moving');
    const rafCount =  this._page._delegate.rafCountForStablePosition();
    const poll = this._evaluateHandleInUtility(([injected, node, rafCount]) => {
      return injected.waitForDisplayedAtStablePositionAndEnabled(node, rafCount);
    }, rafCount);
    const pollHandler = new InjectedScriptPollHandler(progress, await poll);
    const result = await pollHandler.finish();
    progress.logger.info('  element is visible, enabled and does not move');
    return result;
  }

  async _checkHitTargetAt(point: types.Point): Promise<'error:notconnected' | 'error:nothittarget' | 'done'> {
    const frame = await this.ownerFrame();
    if (frame && frame.parentFrame()) {
      const element = await frame.frameElement();
      const box = await element.boundingBox();
      if (!box)
        return 'error:notconnected';
      // Translate from viewport coordinates to frame coordinates.
      point = { x: point.x - box.x, y: point.y - box.y };
    }
    return this._evaluateInUtility(([injected, node, point]) => injected.checkHitTargetAt(node, point), point);
  }
}

// Handles an InjectedScriptPoll running in injected script:
// - streams logs into progress;
// - cancels the poll when progress cancels.
export class InjectedScriptPollHandler<T> {
  private _progress: Progress;
  private _poll: js.JSHandle<types.InjectedScriptPoll<T>> | null;

  constructor(progress: Progress, poll: js.JSHandle<types.InjectedScriptPoll<T>>) {
    this._progress = progress;
    this._poll = poll;
    // Ensure we cancel the poll before progress aborts and returns:
    //   - no unnecessary work in the page;
    //   - no possible side effects after progress promsie rejects.
    this._progress.cleanupWhenAborted(() => this.cancel());
    this._streamLogs();
  }

  private async _streamLogs() {
    while (this._poll && this._progress.isRunning()) {
      const messages = await this._poll.evaluate(poll => poll.takeNextLogs()).catch(e => [] as string[]);
      if (!this._poll || !this._progress.isRunning())
        return;
      for (const message of messages)
        this._progress.logger.info(message);
    }
  }

  async finishHandle(): Promise<js.SmartHandle<T>> {
    try {
      const result = await this._poll!.evaluateHandle(poll => poll.result);
      await this._finishInternal();
      return result;
    } finally {
      await this.cancel();
    }
  }

  async finish(): Promise<T> {
    try {
      const result = await this._poll!.evaluate(poll => poll.result);
      await this._finishInternal();
      return result;
    } finally {
      await this.cancel();
    }
  }

  private async _finishInternal() {
    if (!this._poll)
      return;
    // Retrieve all the logs before continuing.
    const messages = await this._poll.evaluate(poll => poll.takeLastLogs()).catch(e => [] as string[]);
    for (const message of messages)
      this._progress.logger.info(message);
  }

  async cancel() {
    if (!this._poll)
      return;
    const copy = this._poll;
    this._poll = null;
    await copy.evaluate(p => p.cancel()).catch(e => {});
    copy.dispose();
  }
}

export function toFileTransferPayload(files: types.FilePayload[]): types.FileTransferPayload[] {
  return files.map(file => ({
    name: file.name,
    type: file.mimeType,
    data: file.buffer.toString('base64')
  }));
}

function throwFatalDOMError<T>(result: T | FatalDOMError): T {
  if (result === 'error:notelement')
    throw new Error('Node is not an element');
  if (result === 'error:nothtmlelement')
    throw new Error('Not an HTMLElement');
  if (result === 'error:notfillableelement')
    throw new Error('Element is not an <input>, <textarea> or [contenteditable] element');
  if (result === 'error:notfillableinputtype')
    throw new Error('Input of this type cannot be filled');
  if (result === 'error:notfillablenumberinput')
    throw new Error('Cannot type text into input[type=number]');
  if (result === 'error:notvaliddate')
    throw new Error(`Malformed value`);
  if (result === 'error:notinput')
    throw new Error('Node is not an HTMLInputElement');
  if (result === 'error:notselect')
    throw new Error('Element is not a <select> element.');
  return result;
}

function throwRetargetableDOMError<T>(result: T | RetargetableDOMError): T {
  if (result === 'error:notconnected')
    throw new Error('Element is not attached to the DOM');
  return result;
}

function assertDone(result: 'done'): void {
  // This function converts 'done' to void and ensures typescript catches unhandled errors.
}

function roundPoint(point: types.Point): types.Point {
  return {
    x: (point.x * 100 | 0) / 100,
    y: (point.y * 100 | 0) / 100,
  };
}

export type SchedulableTask<T> = (injectedScript: js.JSHandle<InjectedScript>) => Promise<js.JSHandle<types.InjectedScriptPoll<T>>>;

export function waitForSelectorTask(selector: SelectorInfo, state: 'attached' | 'detached' | 'visible' | 'hidden'): SchedulableTask<Element | undefined> {
  return injectedScript => injectedScript.evaluateHandle((injected, { parsed, state }) => {
    let lastElement: Element | undefined;

    return injected.pollRaf((progress, continuePolling) => {
      const element = injected.querySelector(parsed, document);
      const visible = element ? injected.isVisible(element) : false;

      if (lastElement !== element) {
        lastElement = element;
        if (!element)
          progress.log(`  selector did not resolve to any element`);
        else
          progress.log(`  selector resolved to ${visible ? 'visible' : 'hidden'} ${injected.previewNode(element)}`);
      }

      switch (state) {
        case 'attached':
          return element ? element : continuePolling;
        case 'detached':
          return !element ? undefined : continuePolling;
        case 'visible':
          return visible ? element : continuePolling;
        case 'hidden':
          return !visible ? undefined : continuePolling;
      }
    });
  }, { parsed: selector.parsed, state });
}

export function dispatchEventTask(selector: SelectorInfo, type: string, eventInit: Object): SchedulableTask<undefined> {
  return injectedScript => injectedScript.evaluateHandle((injected, { parsed, type, eventInit }) => {
    return injected.pollRaf((progress, continuePolling) => {
      const element = injected.querySelector(parsed, document);
      if (element)
        injected.dispatchEvent(element, type, eventInit);
      return element ? undefined : continuePolling;
    });
  }, { parsed: selector.parsed, type, eventInit });
}

export function textContentTask(selector: SelectorInfo): SchedulableTask<string | null> {
  return injectedScript => injectedScript.evaluateHandle((injected, parsed) => {
    return injected.pollRaf((progress, continuePolling) => {
      const element = injected.querySelector(parsed, document);
      return element ? element.textContent : continuePolling;
    });
  }, selector.parsed);
}
