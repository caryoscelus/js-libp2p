FROM node:18

WORKDIR /app
COPY package.json .
COPY ./node_modules ./node_modules
COPY ./packages ./packages
COPY ./interop ./interop

WORKDIR /app/interop

ENTRYPOINT [ "npm", "run", "test:interop:multidim", "--", "--build", "false", "--types", "false", "-t", "node" ]
