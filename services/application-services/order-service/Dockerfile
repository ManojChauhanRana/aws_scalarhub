# syntax = docker/dockerfile:1

# Make sure RUBY_VERSION matches the Ruby version in .ruby-version and Gemfile
ARG RUBY_VERSION=3.2.2
FROM registry.docker.com/library/ruby:$RUBY_VERSION-slim as base

# Rails app lives here
WORKDIR /rails

# Set production environment
ENV RAILS_ENV="production" \
    BUNDLE_DEPLOYMENT="1" \
    BUNDLE_PATH="/usr/local/bundle" \
   BUNDLE_WITHOUT="development" \
    SECRET_KEY_BASE="H9XCqDbdXciUQHcpb4OIL53IBTMq612znaNANk3/j+UYAPLfsLWcBu3+6fOvT9y3pmVj0NQEZFI2Fgby8el557NPQIimH2Rg8mPUe81Iy/+NfYgEfhB1IAbo8S9aYgOCP1Z3AC1ApWxE5E3zMEIHaAvsmuO8Z7QophMfg2a80HIND2efLSG7enKr76q98UjHvuG/p9xVMREelkQzrbPgBzoIpP2SHRR9Oux28iVoP5aPd7YyMDJSb6bhH2XqMZKCMeUmL5XYdq/Twd1LvG54aulVSxydVgkDgui5JUljfB01J1t3dbs+GLoyFPZqpTDR7aj6i6b+LUn1ZDNCJ1mnwGUfjFlOQ6+7+6jQDWgYx5wEoWA+a3cSBmKVoSxNKu9cE/9ikQN6Yr855giE3axW4WYGOllD--Uj+QDkfiV5bPwTES--PQVYUcjXf0Rhl3Um0P5Z7Q=="

# Throw-away build stage to reduce size of final image
FROM base as build

# Install packages needed to build gems
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential git libvips pkg-config

# Install application gems
COPY Gemfile Gemfile.lock ./
RUN bundle install && \
    rm -rf ~/.bundle/ "${BUNDLE_PATH}"/ruby/*/cache "${BUNDLE_PATH}"/ruby/*/bundler/gems/*/.git && \
    bundle exec bootsnap precompile --gemfile

# Copy application code
COPY . .

# Precompile bootsnap code for faster boot times
RUN bundle exec bootsnap precompile app/ lib/

# Adjust binfiles to be executable on Linux
RUN chmod +x bin/* && \
    sed -i "s/\r$//g" bin/* && \
    sed -i 's/ruby\.exe$/ruby/' bin/*

# Precompiling assets for production without requiring secret RAILS_MASTER_KEY
RUN SECRET_KEY_BASE_DUMMY=1 ./bin/rails assets:precompile


# Final stage for app image
FROM base

# Install packages needed for deployment
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y curl libsqlite3-0 libvips && \
    rm -rf /var/lib/apt/lists /var/cache/apt/archives

# Copy built artifacts: gems, application
COPY --from=build /usr/local/bundle /usr/local/bundle
COPY --from=build /rails /rails

# Run and own only the runtime files as a non-root user for security
RUN useradd rails --create-home --shell /bin/bash && \
    chown -R rails:rails db log storage tmp
USER rails:rails

# Entrypoint prepares the database.
ENTRYPOINT ["/rails/bin/docker-entrypoint"]

# Start the server by default, this can be overwritten at runtime
EXPOSE 3000
CMD ["./bin/rails", "server"]