FROM node

WORKDIR /usr/src/server

COPY package*.json /usr/src/server/

RUN npm install -g typescript
RUN npm install -g @zwave-js/server

EXPOSE 3000

ENTRYPOINT ["zwave-server"] 
