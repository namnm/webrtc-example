pnpm i && \
  scp server/nginx.conf REMOTE_SSH_HOST:/etc/nginx/conf.d/webrtc-example.conf && \
  ssh REMOTE_SSH_HOST "sudo service nginx restart" && \
  cd react-app && \
  yarn build && \
  mv build webrtc-example-react-app && \
  zip -vr webrtc-example-react-app.zip webrtc-example-react-app && \
  scp webrtc-example-react-app.zip REMOTE_SSH_HOST:/var/www && \
  rm -rf webrtc-example-react-app* && \
  ssh REMOTE_SSH_HOST "
    cd /var/www &&
    rm -rf webrtc-example-react-app &&
    unzip webrtc-example-react-app.zip &&
    rm -f webrtc-example-react-app.zip &&
    sudo service nginx restart
  ";
