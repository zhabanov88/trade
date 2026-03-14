# Базовый образ Nginx
FROM nginx:alpine

# Копирование конфигов Nginx внутрь контейнера
#COPY default.conf /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Экспонирование стандартного порта Nginx
EXPOSE 5001

CMD ["nginx", "-g", "daemon off;"]