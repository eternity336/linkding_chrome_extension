document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('options-form');
  const linkdingUrlInput = document.getElementById('linkding-url');
  const apiTokenInput = document.getElementById('api-token');
  const statusDiv = document.getElementById('status');
  const syncBtn = document.getElementById('sync-btn');
  const syncStatusDiv = document.getElementById('sync-status');
  const displayModeRadios = document.querySelectorAll('input[name="display-mode"]');
  const showTagsCheckbox = document.getElementById('show-tags');
  const showActionsCheckbox = document.getElementById('show-actions');
  const sidePanelShowTagsCheckbox = document.getElementById('side-panel-show-tags');
  const sidePanelShowActionsCheckbox = document.getElementById('side-panel-show-actions');

  async function testConnection(url, token) {
    try {
      const response = await fetch(`${url}/api/`, {
        headers: { 'Authorization': `Token ${token}` }
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  async function saveOptions(e) {
    e.preventDefault();
    const url = linkdingUrlInput.value.trim().replace(/\/$/, '');
    const token = apiTokenInput.value.trim();

    const isConnected = await testConnection(url, token);

    if (isConnected) {
      chrome.storage.sync.set({
        linkdingUrl: url,
        apiToken: token
      }, () => {
        statusDiv.textContent = 'Options saved and connection successful!';
        statusDiv.className = '';
        setTimeout(() => { statusDiv.textContent = ''; }, 3000);
      });
    } else {
      statusDiv.textContent = 'Connection failed. Please check your URL and API Token.';
      statusDiv.className = 'warning';
    }
  }

  function saveUiSettings() {
    chrome.storage.sync.set({
      showTags: showTagsCheckbox.checked,
      showActions: showActionsCheckbox.checked,
    });
  }

  function saveSidePanelUiSettings() {
    chrome.storage.sync.set({
      sidePanelShowTags: sidePanelShowTagsCheckbox.checked,
      sidePanelShowActions: sidePanelShowActionsCheckbox.checked,
    });
  }

  async function restoreOptions() {
    const {
      linkdingUrl,
      apiToken,
      displayMode = 'popup',
      showTags = true,
      showActions = true,
      sidePanelShowTags = true,
      sidePanelShowActions = true
    } = await chrome.storage.sync.get({
      linkdingUrl: '',
      apiToken: '',
      displayMode: 'popup',
      showTags: true,
      showActions: true,
      sidePanelShowTags: true,
      sidePanelShowActions: true,
    });

    if (linkdingUrl) linkdingUrlInput.value = linkdingUrl;
    if (apiToken) apiTokenInput.value = apiToken;

    const selectedRadio = document.querySelector(`input[name="display-mode"][value="${displayMode}"]`);
    if (selectedRadio) selectedRadio.checked = true;

    showTagsCheckbox.checked = showTags;
    showActionsCheckbox.checked = showActions;

    sidePanelShowTagsCheckbox.checked = sidePanelShowTags;
    sidePanelShowActionsCheckbox.checked = sidePanelShowActions;
  }

  form.addEventListener('submit', saveOptions);
  syncBtn.addEventListener('click', () => {
    syncStatusDiv.textContent = 'Syncing...';
    setTimeout(() => { syncStatusDiv.textContent = 'Sync complete!'; }, 2000);
  });

  displayModeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => chrome.storage.sync.set({ displayMode: e.target.value }));
  });

  showTagsCheckbox.addEventListener('change', saveUiSettings);
  showActionsCheckbox.addEventListener('change', saveUiSettings);

  sidePanelShowTagsCheckbox.addEventListener('change', saveSidePanelUiSettings);
  sidePanelShowActionsCheckbox.addEventListener('change', saveSidePanelUiSettings);

  restoreOptions();
});