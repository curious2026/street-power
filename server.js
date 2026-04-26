const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/places', async (req, res) => {
  const { ll, radius } = req.query;
  const apiKey = process.env.FSQ_API_KEY;

  try {
    const response = await fetch(
      `https://api.foursquare.com/v3/places/search?ll=${ll}&radius=${radius}&limit=50`,
      {
        headers: {
          'Authorization': apiKey,
          'Accept': 'application/json'
        }
      }
    );
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'APIエラー' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
