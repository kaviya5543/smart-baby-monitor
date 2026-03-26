# Baby Cry Detection Frequency Range

The frequency of a baby's cry is distinct and can be broken down into three main ranges:

1. **Fundamental Frequency (Pitch): 200 Hz - 600 Hz**
   - This is the "base" note of the cry.
   - For a normal cry, it's usually around **300 Hz - 450 Hz**.
   - For a "pain" or "distress" cry, it can jump to **500 Hz - 600 Hz** or even higher (hyperphonation).

2. **Harmonics & Resonance: 2,000 Hz - 4,000 Hz**
   - These are the frequencies that make a cry sound "piercing" or "urgent".
   - Humans are most sensitive to sounds in this range, which is why we find baby cries so hard to ignore.
   - Detection systems often look for high energy in this specific band to distinguish a cry from background talking (which usually has less energy here).

3. **Upper Harmonics: Up to 8,000 Hz**
   - Modern AI models often analyze up to this range to ensure the "texture" of the sound matches a cry.

### Recommended Frequency Filter for Coding:
If you are building a manual frequency detector (using Web Audio API FFT), you should focus on:
- **Low Bound:** 250 Hz (To filter out low-end hum/rumble)
- **High Bound:** 4,500 Hz (To capture all important crying characteristics)
- **Peak Sensitivity:** 3,000 Hz

---

### How to use this in your code:
In your `baby.js`, you are currently using a Teachable Machine AI model. If the AI is failing, we can add a **Frequency Validator** as a secondary check.

Would you like me to implement a frequency-based "double-check" logic in your `baby.js` to make the detection more reliable?
