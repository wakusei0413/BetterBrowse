/**
 * @file form-detector.js
 * @description 页面表单输入保护探测器（检测未保存修改或正在键入的输入控件）
 * @encoding UTF-8
 */

export class FormDetector {
  /**
   * 探测当前页面是否存在活跃输入或未提交修改
   * @returns {{ hasActiveInput: boolean, reason?: string }}
   */
  static detectActiveForm() {
    try {
      // 1. 检测当前获得焦点的元素是否属于输入类控件
      const activeEl = document.activeElement;
      if (activeEl && activeEl !== document.body && activeEl !== document.documentElement) {
        const tagName = activeEl.tagName.toLowerCase();
        const isEditable = activeEl.isContentEditable;

        if (tagName === 'textarea') {
          return {
            hasActiveInput: true,
            reason: '文本域 (textarea) 正在输入中'
          };
        }

        if (tagName === 'input') {
          const type = (activeEl.getAttribute('type') || 'text').toLowerCase();
          // 忽略只读、按钮类、提交类 input
          const nonTypingTypes = ['button', 'submit', 'reset', 'checkbox', 'radio', 'hidden', 'image'];
          if (!nonTypingTypes.includes(type)) {
            return {
              hasActiveInput: true,
              reason: `输入框 (input[type="${type}"]) 正在输入中`
            };
          }
        }

        if (isEditable) {
          return {
            hasActiveInput: true,
            reason: '富文本/可编辑区域正在编辑中'
          };
        }
      }

      // 2. 深度扫描页面中被用户修改过且非空的表单输入框 (Dirty State 检测)
      const textareas = document.querySelectorAll('textarea');
      for (const ta of textareas) {
        if (ta.value && ta.value.trim().length > 0 && ta.value !== ta.defaultValue) {
          return {
            hasActiveInput: true,
            reason: '页面内存在已输入但未提交的多行文本'
          };
        }
      }

      const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])');
      for (const inp of inputs) {
        if (inp.value && inp.value.trim().length > 0 && inp.value !== inp.defaultValue) {
          // 过滤掉默认搜索框等极简查询词，如字数大于 2 并且发生过修改
          if (inp.value.length > 2) {
            return {
              hasActiveInput: true,
              reason: '页面内存在已填写的表单内容'
            };
          }
        }
      }

      // 3. 常见富文本/代码编辑器活跃编辑状态检测（精准排除静态只读代码块）
      // ⚠️ 仅当编辑器（或其内部输入区）真正持有焦点时才判定为"正在编辑"：
      //    Slack/Gmail/Notion 等页面常驻大型 contenteditable 容器，
      //    若仅凭内容长度判定，此类页面将永远无法被自动收纳（系统性误报）
      const richEditors = document.querySelectorAll(
        '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], .monaco-editor, .CodeMirror, .ql-editor, .ProseMirror'
      );
      for (const editor of richEditors) {
        if (editor.getAttribute('aria-readonly') === 'true' || editor.classList.contains('read-only')) {
          continue;
        }
        // 仅当编辑器当前正在被编辑（自身或内部持有焦点）且有实质内容
        const isEditingHere =
          editor === document.activeElement ||
          editor.contains(document.activeElement) ||
          Boolean(editor.querySelector(':focus'));
        if (isEditingHere && editor.isContentEditable && editor.textContent && editor.textContent.trim().length > 0) {
          return {
            hasActiveInput: true,
            reason: '富文本正文处于可编辑状态'
          };
        }
        // 若为 Monaco / CodeMirror 等编辑器且内部输入框正在获取焦点输入
        const hasActiveTyping = editor.querySelector('textarea:focus, input:focus, textarea.inputarea:focus, .CodeMirror-focused');
        if (hasActiveTyping) {
          return {
            hasActiveInput: true,
            reason: '代码编辑器正在键入中'
          };
        }
      }

      return { hasActiveInput: false };
    } catch (err) {
      console.warn('[FormDetector] 检测表单异常:', err);
      return { hasActiveInput: false };
    }
  }
}

