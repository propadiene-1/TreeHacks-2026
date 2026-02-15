const callButton = document.getElementById('callButton');
const phoneInput = document.getElementById('phoneNumber');
const statusDiv = document.getElementById('status');
const queryInput = document.getElementById('queryInput');
const modal = document.getElementById('settings-modal');

callButton.addEventListener('click', async () => {
    const phoneNumber = phoneInput.value.trim();
    
    // Validate phone number
    if (!phoneNumber) {
        showStatus('Please enter a phone number', 'error');
        return;
    }
    
    // Disable button and show loading state
    callButton.disabled = true;
    callButton.textContent = 'Calling...';
    showStatus('Initiating call...', 'info');
    
    try {
        const response = await fetch('/make-call', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ phoneNumber: phoneNumber })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showStatus('Call initiated successfully!', 'success');
        } else {
            showStatus(`Error: ${data.error}`, 'error');
        }
    } catch (error) {
        showStatus('Failed to connect. Please try again.', 'error');
        console.error('Error:', error);
    } finally {
        // Re-enable button
        callButton.disabled = false;
        callButton.textContent = 'Call Now';
    }
});

function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = type;
}

//open toggle in css
document.querySelector('.settings-gear').onclick = () => modal.style.display = 'block';

//close toggle in css
document.querySelector('.close').onclick = () => modal.style.display = 'none';
window.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; }

//save demographics into localStorage
document.getElementById('save-settings').onclick = () => {
    localStorage.setItem('settings', JSON.stringify({
        age: document.getElementById('age').value,
        sex: document.getElementById('sex').value,
        conditions: document.getElementById('conditions').value,
        family: document.getElementById('family').value
    }));
    modal.style.display = 'none';   //close popup on save
};