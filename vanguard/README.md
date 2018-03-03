# Tests

```shell
npm install
npm run lint
npm test
```

# Using the local emulator

```shell
# Start and Depliy
functions start
functions deploy vanguard --trigger-http

# Now you can change code, and it'll be reflected on the local emulator
functions call vanguard

# Check out the logs
functions logs read

# Clean up
functions stop
```

[More information here](https://cloud.google.com/functions/docs/emulator)

# Deploy

```shell
gcloud beta functions deploy vanguard --trigger-http --project=bramp-projects

wget https://us-central1-bramp-projects.cloudfunctions.net/vanguard/VIIIX
```