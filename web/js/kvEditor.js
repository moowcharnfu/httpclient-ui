import { h, clear, toast } from './dom.js';
import { formatSize } from './api.js';

export function createKvEditor(container, opts = {}) {
  const {
    allowFiles = false,
    onChange = () => {},
    keyPlaceholder = '名称',
    valuePlaceholder = '值',
    maxFileBytes = 1024 * 1024,
    maxTotalFileBytes = 160 * 1024 * 1024,
  } = opts;
  let rows = [];
  let fileMaxBytes = maxFileBytes;
  let totalFileMaxBytes = maxTotalFileBytes;
  const fileVersions = new WeakMap();

  function setFileLimits({ maxFileBytes: nextMax, maxTotalFileBytes: nextTotal }) {
    if (Number.isFinite(nextMax)) fileMaxBytes = nextMax;
    if (Number.isFinite(nextTotal)) totalFileMaxBytes = nextTotal;
  }

  function emit() {
    onChange(rows);
  }

  function invalidateFile(row) {
    fileVersions.set(row, (fileVersions.get(row) || 0) + 1);
  }

  function readFile(file, row) {
    if (file.size > fileMaxBytes) {
      toast(`单个文件 ${formatSize(file.size)} 超过上限 ${formatSize(fileMaxBytes)}；请在 Body 区调整“单次上传上限”后重试`, 'error');
      return;
    }
    const otherBytes = rows.reduce((total, item) =>
      total + (item !== row && item.kind === 'file' ? (item.fileSize || 0) : 0), 0);
    if (otherBytes + file.size > totalFileMaxBytes) {
      toast(`表单文件合计 ${formatSize(otherBytes + file.size)} 超过上限 ${formatSize(totalFileMaxBytes)}，请减少文件或降低单次上传上限`, 'error');
      return;
    }
    invalidateFile(row);
    const version = fileVersions.get(row);
    delete row.base64;
    delete row.fileName;
    delete row.contentType;
    row.fileSize = file.size;
    row.filePending = true;
    const reader = new FileReader();
    reader.onload = () => {
      if (fileVersions.get(row) !== version || !rows.includes(row)) return;
      const dataUrl = String(reader.result);
      row.base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      row.fileName = file.name;
      row.fileSize = file.size;
      row.filePending = false;
      row.contentType = file.type || 'application/octet-stream';
      render();
      emit();
    };
    reader.onerror = () => {
      if (fileVersions.get(row) !== version || !rows.includes(row)) return;
      delete row.base64;
      delete row.fileName;
      delete row.fileSize;
      delete row.filePending;
      delete row.contentType;
      render();
      emit();
      toast(`文件读取失败: ${file.name}`, 'error');
    };
    reader.readAsDataURL(file);
  }

  function render() {
    clear(container);
    const table = h('div', { class: 'kv-table' });
    rows.forEach((row, i) => {
      const enabled = h('input', {
        type: 'checkbox',
        checked: row.enabled !== false,
        title: '启用/禁用',
        onChange: (e) => {
          row.enabled = e.target.checked;
          emit();
        },
      });
      const key = h('input', {
        class: 'kv-key',
        value: row.key || '',
        placeholder: keyPlaceholder,
        onInput: (e) => {
          row.key = e.target.value;
          emit();
        },
      });

      let valueCell;
      if (allowFiles && row.kind === 'file') {
        const picker = h('input', {
          type: 'file',
          onChange: (e) => {
            const file = e.target.files[0];
            e.target.value = '';
            if (file) readFile(file, row);
          },
        });
        const info = row.fileName
          ? h('span', { class: 'file-info' }, `${row.fileName}（${formatSize(row.fileSize || 0)}）`)
          : h('span', { class: 'file-info muted' }, '未选择文件');
        const clearBtn = row.fileName
          ? h('button', {
              class: 'mini',
              onClick: () => {
                invalidateFile(row);
                delete row.base64;
                delete row.fileName;
                delete row.fileSize;
                delete row.filePending;
                delete row.contentType;
                render();
                emit();
              },
            }, '清除')
          : null;
        valueCell = h('div', { class: 'kv-file' }, picker, info, clearBtn);
      } else {
        valueCell = h('input', {
          class: 'kv-value',
          value: row.value || '',
          placeholder: valuePlaceholder,
          onInput: (e) => {
            row.value = e.target.value;
            emit();
          },
        });
      }

      const kindSelect = allowFiles
        ? h('select', {
            class: 'kv-kind',
            onChange: (e) => {
              invalidateFile(row);
              row.kind = e.target.value;
              if (row.kind !== 'file') {
                delete row.base64;
                delete row.fileName;
                delete row.fileSize;
                delete row.filePending;
                delete row.contentType;
              }
              render();
              emit();
            },
          },
            h('option', { value: 'text' }, '文本'),
            h('option', { value: 'file' }, '文件'))
        : null;
      if (kindSelect) kindSelect.value = row.kind === 'file' ? 'file' : 'text';

      const del = h('button', {
        class: 'mini danger',
        title: '删除该行',
        onClick: () => {
          rows.splice(i, 1);
          render();
          emit();
        },
      }, '✕');

      table.append(h('div', { class: 'kv-row' }, enabled, key, kindSelect, valueCell, del));
    });
    const addBtn = h('button', {
      class: 'mini add-row',
      onClick: () => {
        rows.push({ key: '', value: '', enabled: true, kind: 'text' });
        render();
        emit();
        const inputs = container.querySelectorAll('.kv-key');
        if (inputs.length > 0) inputs[inputs.length - 1].focus();
      },
    }, '+ 添加一行');
    container.append(table, addBtn);
  }

  return {
    getRows: () => rows,
    setFileLimits,
    setRows(newRows, silent = false) {
      rows = (newRows || []).map((r) => ({ enabled: true, kind: 'text', ...r }));
      render();
      if (!silent) emit();
    },
    render,
  };
}