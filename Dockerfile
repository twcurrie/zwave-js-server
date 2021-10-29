FROM arm64v8/node:slim

WORKDIR /usr/src/server

COPY package*.json /

RUN sudo npm install -g 
RUN sudo npm install -g @zwave-js/server

EXPOSE 3000

ENTRYPOINT ["zwave-server] 
