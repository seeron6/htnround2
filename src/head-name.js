import './head-name.css';

export function nameFromFile(filename = '') {
  return filename.replace(/\.[^.]+$/, '').slice(0, 80);
}

// A native modal keeps naming keyboard-accessible, including over the scan dialog.
// Cancel resolves to null so callers never start an upload or overwrite a name.
export function requestHeadName({ name = '', rename = false, save } = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'head-name-dialog';
  dialog.setAttribute('aria-labelledby', 'head-name-title');
  dialog.innerHTML = /* HTML */ `
    <form>
      <h2 id="head-name-title">${rename ? 'Rename head' : 'Name your head'}</h2>
      <p>Choose a name you’ll recognize in your saved heads.</p>
      <label for="head-name-input">Head name</label>
      <input
        id="head-name-input"
        type="text"
        maxlength="80"
        required
        autocomplete="off"
        placeholder="e.g. Seeron with glasses"
      />
      <p class="head-name-error" role="status"></p>
      <div class="head-name-actions">
        <button type="button">Cancel</button>
        <button type="submit">${rename ? 'Save name' : 'Continue'}</button>
      </div>
    </form>
  `;
  const form = dialog.querySelector('form');
  const input = dialog.querySelector('input');
  const cancel = dialog.querySelector('[type="button"]');
  const submit = dialog.querySelector('[type="submit"]');
  const error = dialog.querySelector('[role="status"]');
  input.value = name.slice(0, 80);
  document.body.append(dialog);
  return new Promise((resolve) => {
    let saving = false;
    const finish = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    cancel.onclick = () => finish(null);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      if (!saving) finish(null);
    });
    input.oninput = () => input.setCustomValidity('');
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (saving) return;
      const value = input.value.trim().replace(/\s+/g, ' ');
      input.setCustomValidity(value ? '' : 'Enter a name for this head.');
      if (!form.reportValidity()) return;
      saving = true;
      input.disabled = cancel.disabled = submit.disabled = true;
      error.textContent = '';
      try {
        await save?.(value);
        finish(value);
      } catch (failure) {
        error.textContent = failure.message || 'Could not save the name. Try again.';
        saving = false;
        input.disabled = cancel.disabled = submit.disabled = false;
        input.focus();
      }
    };
    dialog.showModal();
    input.focus();
    input.select();
  });
}
