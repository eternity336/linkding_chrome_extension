function setActionForMode(mode) {
    if (mode === 'sidebar') {
        // Open side panel on click, disable popup
        chrome.action.setPopup({ popup: '' }); // An empty string disables the popup
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
            .catch((error) => console.error(error));
    } else { // default to 'popup'
        // Open popup on click, disable side panel direct open
        chrome.action.setPopup({ popup: 'popup.html' });
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
            .catch((error) => console.error(error));
    }
}

// --- API Helper ---
async function createBookmark(url, token, linkUrl, title) {
    const response = await fetch(`${url}/api/bookmarks/`, {
        method: 'POST',
        headers: {
            'Authorization': `Token ${token}`,
            'Content-Type': 'application/json'
        },
        // Use the provided title, or the link's URL as a fallback title
        body: JSON.stringify({ url: linkUrl, title: title || linkUrl })
    });
    if (!response.ok) throw new Error(`API Error: ${await response.text()}`);
    return response.json();
}

// Set the initial action on install/startup
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.sync.get('displayMode', (data) => {
        setActionForMode(data.displayMode || 'popup');
    });

    // Add a context menu item to always have access to the manager
    chrome.contextMenus.create({
        id: 'open-manager',
        title: 'Open Bookmark Manager',
        contexts: ['action']
    });

    // Add a context menu item for bookmarking links
    chrome.contextMenus.create({
        id: 'bookmark-link',
        title: 'Bookmark this link in Linkding',
        contexts: ['link']
    });
});

// Listen for changes in storage to update the action on the fly
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' && changes.displayMode) {
        setActionForMode(changes.displayMode.newValue);
    }
});

// Listener for the context menu
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'open-manager') {
        chrome.tabs.create({ url: 'manager.html' });
    } else if (info.menuItemId === 'bookmark-link') {
        if (!info.linkUrl) return;

        try {
            const { linkdingUrl, apiToken } = await chrome.storage.sync.get(['linkdingUrl', 'apiToken']);
            if (!linkdingUrl || !apiToken) {
                chrome.notifications.create({
                    type: 'basic',
                    iconUrl: 'icons/favicon128.png',
                    title: 'Linkding Extension Error',
                    message: 'Please configure your Linkding URL and API Token in the extension options.'
                });
                return;
            }
            const cleanedUrl = linkdingUrl.trim().replace(/\/$/, '');

            // Use any selected text on the page as the title, otherwise the API will use the URL
            await createBookmark(cleanedUrl, apiToken, info.linkUrl, info.selectionText);

            // Invalidate cache so other parts of the extension see the new bookmark
            await chrome.storage.local.remove(['cachedBookmarks', 'cacheTimestamp']);

            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icons/favicon128.png',
                title: 'Linkding Bookmark Saved',
                message: `Successfully bookmarked: ${info.linkUrl}`
            });

        } catch (error) {
            chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icons/favicon128.png',
                title: 'Linkding Bookmark Failed',
                message: `Could not save bookmark. Error: ${error.message}`
            });
            console.error('Failed to bookmark link:', error);
        }
    }
});