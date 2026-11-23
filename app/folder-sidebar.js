const productDragType = 'application/x-archiver-product';
const folderDragType = 'application/x-archiver-collection';

function createFolderSidebar(nav, { select, organize, confirmDelete, reportError }) {
  const doc = nav.ownerDocument;
  const rows = new Map();
  let editor = null;
  function node(tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }
  function control(cls, text, label) {
    const b = node('button', cls, text);
    b.type = 'button';
    if (label) { b.setAttribute('aria-label', label); b.title = label; }
    return b;
  }
  function closeEditor(focus = false) {
    if (!editor) return;
    const { form, pencil } = editor;
    editor = null;
    form.remove();
    pencil.setAttribute('aria-expanded', 'false');
    if (focus) pencil.focus();
  }
  function edit(row, folder, pencil) {
    const wasOpen = editor?.row === row;
    closeEditor(wasOpen);
    if (wasOpen) return;
    const form = node('form', 'collection-editor');
    const label = node('label', '', 'Title');
    const input = node('input');
    input.required = true; input.maxLength = 80; input.value = folder.name;
    label.append(input);
    const actions = node('div', 'collection-actions');
    const save = control('primary', 'Save'); save.type = 'submit';
    const cancel = control('', 'Cancel'), remove = control('collection-delete', 'Delete');
    actions.append(save, cancel, remove);
    const error = node('div', 'file-error'); error.setAttribute('role', 'status');
    form.append(label, actions, error); row.append(form);
    editor = { row, form, pencil }; pencil.setAttribute('aria-expanded', 'true');
    async function apply(change) {
      save.disabled = true; remove.disabled = true;
      try { await organize(change); if (editor?.form === form) closeEditor(true); }
      catch (e) { error.textContent = e.message; }
      finally { save.disabled = false; remove.disabled = false; }
    }
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (!save.disabled) apply({ type: 'rename-folder', folderId: folder.id, name: input.value });
    });
    cancel.addEventListener('click', () => closeEditor(true));
    form.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); closeEditor(true); } });
    remove.addEventListener('click', () => {
      if (confirmDelete(folder.name)) apply({ type: 'delete-folder', folderId: folder.id });
    });
    input.focus(); input.select();
  }
  function createRow(folder) {
    const row = node('section', 'collection-row');
    const bar = node('div', 'collection-bar');
    const selectButton = control('folder');
    const heading = node('span', 'collection-heading'), title = node('span', 'collection-name'), count = node('small');
    const svgNS = 'http://www.w3.org/2000/svg';
    const icon = doc.createElementNS(svgNS, 'svg'), shape = doc.createElementNS(svgNS, 'use');
    icon.setAttribute('class', 'collection-icon'); icon.setAttribute('aria-hidden', 'true');
    shape.setAttribute('href', '#collection-folder-shape');
    icon.append(shape); heading.append(icon, title); selectButton.append(heading, count);
    selectButton.addEventListener('click', () => select(folder.id));
    bar.append(selectButton); row.append(bar);
    const entry = { row, selectButton, title, count, folder };
    if (!folder.editable) return entry;
    row.classList.add('editable');
    const grip = control('collection-grip', '⠿', 'Drag to reorder or use the up and down arrow keys');
    const pencil = control('collection-edit', '✎', 'Edit collection');
    pencil.setAttribute('aria-expanded', 'false');
    pencil.addEventListener('click', () => edit(row, entry.folder, pencil));
    grip.draggable = true;
    grip.addEventListener('dragstart', e => {
      e.dataTransfer.setData(folderDragType, folder.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    grip.addEventListener('dragend', clearDrop);
    grip.addEventListener('keydown', e => {
      if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
      e.preventDefault();
      const down = e.key === 'ArrowDown', target = down ? row.nextElementSibling : row.previousElementSibling;
      if (target?.classList.contains('editable')) organize({ type: 'move-folder', folderId: folder.id,
        targetId: target.dataset.id, position: down ? 'after' : 'before' }).catch(reportError);
    });
    bar.prepend(grip); bar.append(pencil);
    row.dataset.id = folder.id;
    function destination(e) {
      if (e.dataTransfer.types.includes(productDragType)) return 'add';
      if (!e.dataTransfer.types.includes(folderDragType)) return '';
      const rect = bar.getBoundingClientRect();
      return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    }
    bar.addEventListener('dragover', e => {
      const position = destination(e);
      if (!position) return;
      e.preventDefault(); e.dataTransfer.dropEffect = position === 'add' ? 'copy' : 'move';
      row.dataset.drop = position;
    });
    bar.addEventListener('dragleave', e => {
      if (!bar.contains(e.relatedTarget)) delete row.dataset.drop;
    });
    bar.addEventListener('drop', e => {
      const position = destination(e);
      clearDrop();
      if (!position) return;
      e.preventDefault();
      const change = position === 'add'
        ? { type: 'add-to-folder', folderId: folder.id, productId: e.dataTransfer.getData(productDragType) }
        : { type: 'move-folder', folderId: e.dataTransfer.getData(folderDragType), targetId: folder.id, position };
      organize(change).catch(reportError);
    });
    return entry;
  }
  function clearDrop() { for (const { row } of rows.values()) delete row.dataset.drop; }
  return function render(folders, selected) {
    const ids = new Set(folders.map(f => f.id));
    for (const [id, {row}] of rows) {
      if (ids.has(id)) continue;
      if (editor?.row === row) closeEditor();
      row.remove(); rows.delete(id);
    }
    folders.forEach((folder, index) => {
      if (!rows.has(folder.id)) rows.set(folder.id, createRow(folder));
      const entry = rows.get(folder.id); entry.folder = folder;
      entry.title.textContent = folder.name;
      entry.count.textContent = folder.label;
      entry.selectButton.classList.toggle('active', selected === folder.id);
      if (nav.children[index] !== entry.row) nav.insertBefore(entry.row, nav.children[index] || null);
    });
  };
}

if (typeof module !== 'undefined') module.exports = { createFolderSidebar, productDragType, folderDragType };
