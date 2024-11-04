## WebRTC example by namnm

#### Setup and deployment

Below is a proof of concept how to set the project up and running on a Ubuntu instance. This can be modified to a better solution using docker and k8s in the future based on those commands.

Ports to be opened: 22 for ssh, 80 for http (will be redirect to https), 443 for https, 3478 and 3479 for turn

##### Install nginx and certbot

```sh
sudo apt-get -y install nginx

# install certbot and get free ssl certificate
sudo apt-get -y install certbot
sudo service nginx stop
sudo certbot certonly --standalone -d YOUR_DNS
sudo service nginx start

# install unzip to quickly upload zip and unzip on the cloud
sudo apt-get -y install unzip

# set permission to deploy on some dirs
sudo chmod -R a+rwX /etc/letsencrypt
sudo chmod -R a+rwX /etc/nginx
sudo chmod -R a+rwX /var/www
```

##### Deploy frontend code and nginx config

```sh
# run this command on our local development computer
# this will build the frontend code, then copy to the ec2 instance through ssh
# we can also build the frontend code on the server, but it will consume a lot of cpu/memory
bash scripts/deploy-react-app.sh

# when we really need to build the frontend code on the server
# we need to look at the scripts and rewrite it into another version instead
```

##### Install nodejs on

```sh
# first follow instruction in this link to install nvm
# https://github.com/nvm-sh/nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash

# install nodejs v16.18.1
# we can install newer versions, but need to test that version first on our local
nvm install v16.18.1

# install pnpm and pm2
npm i -g pnpm pm2
```

##### Run the TURN server

```sh
# install coturn
sudo apt-get -y update
sudo apt-get install coturn -y

# stop the default coturn service and start ours using pm2
sudo service coturn stop
pm2 start --name=turn "turnserver -a -v -n --no-dtls --no-tls -u USERNAME:PASSWORD -r 000"
pm2 save

# restart coturn if already started using pm2
pm2 restart turn
```

##### Run the nodejs server (socket io code in this repository)

```sh
# clone the repository if not yet
cd /var/www
git clone https://github.com/namnm/webrtc-example.git

# install dependencies and start the socket io server using pm2
cd /var/www/webrtc-example/server
pnpm i
pm2 start --name=webrtc-example-server .
pm2 save

# restart the socket io server if already started using pm2
pm2 restart webrtc-example-server
```

##### Resurrect pm2 in case the server restarted

```sh
sudo service coturn stop
pm2 resurrect
```

##### Debug and view log

```sh
pm2 list
# if the above setup correctly, you should see something like this
# ┌────┬───────────────────────────────────┬──────────┬──────┬───────────┬──────────┬──────────┐
# │ id │ name                              │ mode     │ ↺    │ status    │ cpu      │ memory   │
# ├────┼───────────────────────────────────┼──────────┼──────┼───────────┼──────────┼──────────┤
# │ 0  │ turn                              │ fork     │ 0    │ online    │ 0%       │ 11.3mb   │
# │ 1  │ webrtc-example-server             │ fork     │ 22   │ online    │ 0%       │ 174.6mb  │
# └────┴───────────────────────────────────┴──────────┴──────┴───────────┴──────────┴──────────┘

# then to view log:
pm2 log webrtc-example-server
```

##### User action, event flow, logic

Initialize and prepare to join queue:

```
press button open webcam
-> call getUserMedia to get the webcam feed
-> start web socket
-> emit event "setInfo"
-> receive event "setInfoSuccess"
-> press button join queue
-> emit event "queue"
-> now in the queue on the server and user will be put in waiting
```

When the queue find match for 2 users:

```
receive event "match"
-> the first one will create a RTCPeerConnection and emit event "offer"
-> the second one receive that event "offer" then also create a RTCPeerConnection then emit event "answer"
-> during the exchange to initialize the peer to peer connection, there will be events "icecandidate" send back and forth, this is called ICE signaling
-> stream added to the handler and display on the UI
-> set connection status as success
```

##### Configuration

- Socket io interval and timeout: By default socket io library uses 25s for ping interval and 20s for ping timeout which mean it would take up to 45s to notify that the other participant has disconnected
  - Default config: tested with result that there were disconnected peers still showing up and caused the other participant waited for too long to be notified
  - v0.0.7 config 1s for both: tested with result that it was too easy to be disconnected
  - v0.0.8 config 3s for ping interval and 4s for ping timeout: tested with better result
  - v0.0.13 config 3s for ping interval and 15s for ping timeout, the state will be reset and websocket will automatically reconnect to the server on frontend side
- Queue interval:
  - Default config: 3s to run a match pairing check
  - v0.0.13 config 1s for quicker match pairing check so the user wait less
- Skip/next cache:
  - To prevent the user meet the one they already skip/next, or either the other skip/next
  - If the user disconnect or refresh the browser then the cache will be cleared since it is associated with the connection
  - The cache will be cleared automatically in 60m
  - To manually clear the cache, use ws event `forget`
  - v0.0.13 if user click on the generated name, it will call the event and clear the cache. The frontend developer can choose to use the button or switch use timeout to call the event as desired

##### Future improvements

- Consider using a media server such as Mediasoup / Janus / Ant Media Server. The current source code is a raw peer to peer webrtc implementation which doesnt require a media server in exchange for a low server cost to get started as a proof of concept
- Consider using a 3rd party turn service such as Twilio / Vonage OpenTok. The current turn server is a hard code session managed by pm2 on port 3478 3479. It should have tls with port 443 for the best out come as other 3rd party turn service will provide
- Consider deployment with globalization which can help with gloval users, so for example we have our server running on 5 different locations: Canada, US, India, Europe, SEA. When the user connect to the system, it will choose the one nearest or strongest to that user
