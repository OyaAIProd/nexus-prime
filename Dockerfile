FROM node:20-alpine

RUN npm install -g nexus-prime

EXPOSE 3000

ENTRYPOINT ["nexus-prime"]
CMD ["mcp"]
