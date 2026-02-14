const callButton = document.getElementById('callButton');
const phoneInput = document.getElementById('phoneNumber');
const statusDiv = document.getElementById('status');
const queryInput = document.getElementById('queryInput');
const askAIButton = document.getElementById('askAIButton'); //for testing only
const aiResponse = document.getElementById('aiResponse');

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

//for testing: make it automatic later
askAIButton.addEventListener('click', getAIFollowUp);

// Function to get AI follow-up question
async function getAIFollowUp() {
    
    const query = queryInput.value.trim();
    
    if (!query) {
        alert('Please enter a medical query first');
        return;
    }
    
    showAIResponse('Thinking about how to respond...', 'info');

    try {
        const response = await fetch('/get-followup', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ query: query })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showAIResponse(`${data.followUpQuestion}`, 'success');
            console.log('AI Follow-up Question:', data.followUpQuestion);
        } else {
            showAIResponse(`Couldn't generate follow-up. Error: ${data.error}`, 'error');
        }
    } catch (error) {
        alert('Failed to get AI response');
        console.error('Error:', error);
    }
}

function showAIResponse(message, type) {
    aiResponse.textContent = message;
    aiResponse.className = type;
    aiResponse.style.display = 'block';
}