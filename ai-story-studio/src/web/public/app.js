// AI Story Studio — tiny progressive enhancement (no framework, no external requests).
(function () {
  'use strict';

  // Confirmation for destructive / costly actions.
  document.addEventListener('submit', function (event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const message = form.getAttribute('data-confirm');
    if (message && !confirm(message)) {
      event.preventDefault();
      return;
    }
    const button = form.querySelector('button:not([name])');
    if (button) {
      button.setAttribute('disabled', 'disabled');
      button.textContent = 'Working…';
    }
  });

  // Load a chosen file into a hidden textarea (Story Package JSON, backups, reference images).
  document.addEventListener('change', function (event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
    const targetName = input.getAttribute('data-read-into');
    if (!targetName || !input.files || !input.files[0]) return;
    const form = input.form;
    if (!form) return;
    const target = form.querySelector('[name="' + targetName + '"]');
    if (!target) return;
    const reader = new window.FileReader();
    reader.onload = function () {
      target.value = String(reader.result);
      if (target.hasAttribute('hidden')) {
        const note = document.createElement('small');
        note.textContent = 'Loaded ' + input.files[0].name;
        input.parentNode.appendChild(note);
      }
    };
    if (input.getAttribute('data-as') === 'dataurl') reader.readAsDataURL(input.files[0]);
    else reader.readAsText(input.files[0]);
  });
})();
